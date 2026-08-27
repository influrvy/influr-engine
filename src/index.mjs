import { createClient } from "@supabase/supabase-js";
import { createServer } from "node:http";

const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GEMINI_API_KEY", "EVOLUTION_API_URL", "EVOLUTION_API_KEY"];
for (const name of required) if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const requestedModel = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
// Gemini 2.5 Flash is no longer available to newly-created API projects.
// Preserve existing EasyPanel configurations while moving the Engine to the
// current low-cost Flash model without requiring an environment edit.
const model = requestedModel === "gemini-2.5-flash" ? "gemini-3.5-flash-lite" : requestedModel;
const intervalMs = Math.max(2000, Number(process.env.ENGINE_POLL_INTERVAL_MS || 5000));

function clean(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

async function markJob(job, status, error = null) {
  const payload = { status, completed_at: status === "completed" ? new Date().toISOString() : null, error_message: error };
  await supabase.from("engine_jobs").update(payload).eq("id", job.id).eq("organization_id", job.organization_id);
}

async function answerWithGemini({ agent, messages }) {
  const transcript = messages.map((message) => `${message.direction === "incoming" ? "Cliente" : "Assistente"}: ${clean(message.body)}`).join("\n");
  const instructions = [
    "Você é um assistente de atendimento pelo WhatsApp.",
    "Responda em português brasileiro, com clareza, educação e objetividade.",
    "Nunca invente preços, horários, políticas ou dados. Quando faltar informação, diga que a equipe confirmará.",
    "Você só pode tratar do atendimento atual. Não revele dados de outros clientes, dados financeiros ou informações internas.",
    agent.instructions || agent.personality || "",
  ].filter(Boolean).join("\n");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: instructions }] },
      contents: [{ role: "user", parts: [{ text: `Conversa atual:\n${transcript}\n\nResponda somente à última mensagem do cliente.` }] }],
      generationConfig: { temperature: 0.35, maxOutputTokens: 450 },
    }),
  });
  const payload = await response.json().catch(() => null);
  const output = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  if (!response.ok || !clean(output)) throw new Error(payload?.error?.message || "O Gemini não retornou uma resposta válida.");
  return clean(output);
}

async function sendEvolutionText(connection, phone, text) {
  const response = await fetch(`${process.env.EVOLUTION_API_URL.replace(/\/$/, "")}/message/sendText/${encodeURIComponent(connection.external_reference)}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: process.env.EVOLUTION_API_KEY },
    body: JSON.stringify({ number: phone, text, linkPreview: false }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.message || "A Evolution não aceitou o envio da mensagem.");
  }
}

async function processInbound(job) {
  const { data: conversation, error: conversationError } = await supabase
    .from("agent_conversations")
    .select("id,organization_id,agent_id,contact_phone,inbox_id")
    .eq("id", job.conversation_id).eq("organization_id", job.organization_id).single();
  if (conversationError || !conversation?.agent_id || !conversation.contact_phone) throw new Error("A conversa precisa de um agente e telefone para responder.");

  const [{ data: agent, error: agentError }, { data: connection, error: connectionError }, { data: messages, error: messagesError }] = await Promise.all([
    supabase.from("ai_agents").select("id,enabled,instructions,personality").eq("id", conversation.agent_id).eq("organization_id", job.organization_id).single(),
    supabase.from("agent_inboxes").select("whatsapp_connections(external_reference,provider,status)").eq("id", conversation.inbox_id).eq("organization_id", job.organization_id).single(),
    supabase.from("agent_messages").select("direction,body,created_at").eq("conversation_id", conversation.id).eq("organization_id", job.organization_id).order("created_at", { ascending: false }).limit(12),
  ]);
  if (agentError || !agent?.enabled) throw new Error("O agente vinculado está indisponível.");
  const whatsapp = connection?.whatsapp_connections;
  if (connectionError || !whatsapp?.external_reference || whatsapp.provider !== "evolution" || whatsapp.status !== "connected") throw new Error("O número WhatsApp não está conectado à Evolution.");
  if (messagesError || !messages?.length) throw new Error("Não há mensagem para processar.");

  const reply = await answerWithGemini({ agent, messages: [...messages].reverse() });
  await sendEvolutionText(whatsapp, conversation.contact_phone, reply);
  const now = new Date().toISOString();
  const { error: insertError } = await supabase.from("agent_messages").insert({
    organization_id: job.organization_id, conversation_id: conversation.id, direction: "outgoing", sender_type: "agent", body: reply, message_type: "text", delivery_status: "sent", metadata: { provider: "evolution", model },
  });
  if (insertError) throw new Error("A resposta foi enviada, mas não pôde ser registrada.");
  await supabase.from("agent_conversations").update({ last_message_at: now, last_message_preview: reply.slice(0, 220), status: "open" }).eq("id", conversation.id).eq("organization_id", job.organization_id);
}

async function work() {
  const { data: jobs, error } = await supabase.rpc("claim_engine_jobs", { p_limit: 5 });
  if (error) throw new Error(`Não foi possível consultar a fila: ${error.message}`);
  for (const job of jobs || []) {
    try {
      if (job.job_type === "inbound_message") await processInbound(job);
      await markJob(job, "completed");
    } catch (error) {
      await markJob(job, "failed", error instanceof Error ? error.message : "Falha inesperada do engine.");
    }
  }
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try { await work(); } catch (error) { console.error("Engine loop error:", error instanceof Error ? error.message : error); }
  finally { running = false; }
}

console.log(`Influr Engine started with ${model}.`);
// EasyPanel supervises App services through an HTTP port. The Engine is a
// worker, but this small health endpoint keeps the worker observable without
// exposing any data or operational controls.
const port = Number(process.env.PORT || 3000);
createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", service: "influr-engine" }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "Not found" }));
}).listen(port, "0.0.0.0", () => console.log(`Influr Engine health endpoint listening on ${port}.`));
await tick();
setInterval(tick, intervalMs);
