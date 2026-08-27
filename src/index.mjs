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

function money(amount) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(amount || 0) / 100);
}

function allowed(agent, action) {
  return Array.isArray(agent.allowed_actions) && agent.allowed_actions.includes(action);
}

async function loadAgentContext(organizationId, agent) {
  const canReadCatalog = allowed(agent, "catalog.read");
  const canReadAgenda = allowed(agent, "appointments.availability.read");
  const [productsResult, servicesResult, menuResult, sourcesResult, agendaResult] = await Promise.all([
    canReadCatalog ? supabase.from("products").select("name,description,price_from_amount,price_to_amount,sale_amount").eq("organization_id", organizationId).eq("active", true).limit(80) : Promise.resolve({ data: [] }),
    canReadCatalog ? supabase.from("services").select("name,description,duration_minutes,price_from_amount,price_to_amount,price_amount").eq("organization_id", organizationId).eq("active", true).limit(80) : Promise.resolve({ data: [] }),
    canReadCatalog ? supabase.from("menu_items").select("name,description,price_amount,available,menu_categories(name)").eq("organization_id", organizationId).eq("available", true).limit(120) : Promise.resolve({ data: [] }),
    supabase.from("agent_knowledge_sources").select("name,source_type,external_url,storage_path,status").eq("organization_id", organizationId).eq("status", "ready").limit(30),
    canReadAgenda ? supabase.from("appointments").select("starts_at,ends_at,title,status").eq("organization_id", organizationId).in("status", ["scheduled", "confirmed"]).gte("starts_at", new Date().toISOString()).order("starts_at", { ascending: true }).limit(80) : Promise.resolve({ data: [] }),
  ]);
  const products = productsResult.data || [];
  const services = servicesResult.data || [];
  const menuItems = menuResult.data || [];
  const sources = sourcesResult.data || [];
  const appointments = agendaResult.data || [];
  const catalog = [
    ...products.map((item) => `Produto: ${item.name}${item.description ? ` — ${clean(item.description)}` : ""}. Preço: ${money(item.price_from_amount ?? item.sale_amount)}${item.price_to_amount && item.price_to_amount !== (item.price_from_amount ?? item.sale_amount) ? ` a ${money(item.price_to_amount)}` : ""}.`),
    ...services.map((item) => `Serviço: ${item.name}${item.description ? ` — ${clean(item.description)}` : ""}. Duração: ${item.duration_minutes || 60} min. Preço: ${money(item.price_from_amount ?? item.price_amount)}${item.price_to_amount && item.price_to_amount !== (item.price_from_amount ?? item.price_amount) ? ` a ${money(item.price_to_amount)}` : ""}.`),
    ...menuItems.map((item) => `Cardápio: ${item.name}${item.menu_categories?.name ? ` (${item.menu_categories.name})` : ""}${item.description ? ` — ${clean(item.description)}` : ""}. Preço: ${money(item.price_amount)}.`),
  ];
  const agenda = appointments.map((item) => `${new Date(item.starts_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}–${new Date(item.ends_at).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })}: ocupado (${item.title})`).join("\n");
  const knowledge = sources.map((item) => `${item.name} (${item.source_type})${item.external_url ? `: ${item.external_url}` : ""}`).join("\n");
  const pdfParts = [];
  for (const source of sources.filter((item) => item.source_type === "pdf" && item.storage_path).slice(0, 2)) {
    const { data: file, error } = await supabase.storage.from("agent-knowledge").download(source.storage_path);
    if (!error && file && file.size <= 3 * 1024 * 1024) {
      const encoded = Buffer.from(await file.arrayBuffer()).toString("base64");
      pdfParts.push({ inlineData: { mimeType: "application/pdf", data: encoded } });
    }
  }
  return { catalog: catalog.join("\n") || "Nenhum item cadastrado.", agenda: agenda || "Nenhum horário futuro ocupado cadastrado.", knowledge: knowledge || "Nenhuma fonte adicional cadastrada.", pdfParts };
}

async function markJob(job, status, error = null) {
  const payload = { status, completed_at: status === "completed" ? new Date().toISOString() : null, error_message: error };
  await supabase.from("engine_jobs").update(payload).eq("id", job.id).eq("organization_id", job.organization_id);
}

async function answerWithGemini({ agent, messages, context }) {
  const transcript = messages.map((message) => `${message.direction === "incoming" ? "Cliente" : "Assistente"}: ${clean(message.body)}`).join("\n");
  const instructions = [
    "Você é um assistente de atendimento pelo WhatsApp.",
    "Responda em português brasileiro, com clareza, educação e objetividade.",
    "Use primeiro as instruções do agente e as informações do contexto abaixo. Não responda genericamente se houver uma informação cadastrada.",
    "Nunca invente preços, horários, políticas ou dados. Quando faltar informação, diga apenas que vai confirmar com a equipe.",
    "Você só pode tratar do atendimento atual. Não revele dados de outros clientes, dados financeiros ou informações internas.",
    agent.role ? `Função: ${agent.role}.` : "",
    agent.description || "",
    agent.personality || "",
    agent.instructions || "",
    `Permissões: ${agent.allowed_actions?.join(", ") || "somente responder"}.`,
    allowed(agent, "appointments.create") ? "Você pode orientar o agendamento. Só confirme a criação depois de receber data, horário e nome completos; se não tiver todos esses dados, peça apenas o dado que falta." : "Não prometa criar ou alterar agendamentos; encaminhe esses pedidos de modo breve.",
    "Seja breve: normalmente até duas frases curtas. Não use textos de espera longos nem diga que irá confirmar algo quando a resposta estiver no contexto.",
    `CATÁLOGO AUTORIZADO:\n${context.catalog}`,
    `AGENDA AUTORIZADA:\n${context.agenda}`,
    `FONTES AUTORIZADAS:\n${context.knowledge}`,
  ].filter(Boolean).join("\n");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: instructions }] },
      contents: [{ role: "user", parts: [{ text: `Conversa atual:\n${transcript}\n\nResponda somente à última mensagem do cliente. PDFs autorizados, quando existirem, estão anexados a esta conversa.` }, ...context.pdfParts] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 140 },
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
  if (conversationError || !conversation?.contact_phone) throw new Error("A conversa precisa de um telefone para responder.");

  const agentRequest = conversation.agent_id
    ? supabase.from("ai_agents").select("id,enabled,role,description,instructions,personality,tone_of_voice,allowed_actions,paused_until,max_replies_per_conversation,handoff_keywords").eq("id", conversation.agent_id).eq("organization_id", job.organization_id).single()
    : Promise.resolve({ data: null, error: null });
  const [{ data: loadedAgent, error: agentError }, { data: connection, error: connectionError }, { data: messages, error: messagesError }] = await Promise.all([
    agentRequest,
    supabase.from("agent_inboxes").select("whatsapp_connections(external_reference,provider,status,agent_id)").eq("id", conversation.inbox_id).eq("organization_id", job.organization_id).single(),
    supabase.from("agent_messages").select("direction,body,created_at").eq("conversation_id", conversation.id).eq("organization_id", job.organization_id).order("created_at", { ascending: false }).limit(12),
  ]);
  const whatsapp = connection?.whatsapp_connections;
  let agent = loadedAgent;
  // A conversa pode existir desde antes de o usuário trocar o agente do número.
  // Nesse caso, o número conectado é a fonte de verdade para os próximos atendimentos.
  if ((agentError || !agent?.enabled) && whatsapp?.agent_id) {
    const { data: currentAgent } = await supabase
      .from("ai_agents")
      .select("id,enabled,role,description,instructions,personality,tone_of_voice,allowed_actions,paused_until,max_replies_per_conversation,handoff_keywords")
      .eq("id", whatsapp.agent_id)
      .eq("organization_id", job.organization_id)
      .maybeSingle();
    if (currentAgent?.enabled) {
      agent = currentAgent;
      await supabase
        .from("agent_conversations")
        .update({ agent_id: currentAgent.id })
        .eq("id", conversation.id)
        .eq("organization_id", job.organization_id);
    }
  }
  // Protege atendimentos que ficaram com um ID removido após apagar e criar
  // novamente um agente. Só faz a recuperação se havia um vínculo anterior.
  if (!agent?.enabled && (conversation.agent_id || whatsapp?.agent_id)) {
    const { data: recoveredAgent } = await supabase
      .from("ai_agents")
      .select("id,enabled,role,description,instructions,personality,tone_of_voice,allowed_actions,paused_until,max_replies_per_conversation,handoff_keywords")
      .eq("organization_id", job.organization_id)
      .eq("enabled", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recoveredAgent) {
      agent = recoveredAgent;
      await supabase
        .from("agent_conversations")
        .update({ agent_id: recoveredAgent.id })
        .eq("id", conversation.id)
        .eq("organization_id", job.organization_id);
    }
  }
  if (!agent?.enabled) throw new Error("O agente vinculado está indisponível.");
  if (agent.paused_until && new Date(agent.paused_until) > new Date()) return;
  if (connectionError || !whatsapp?.external_reference || whatsapp.provider !== "evolution" || whatsapp.status !== "connected") throw new Error("O número WhatsApp não está conectado à Evolution.");
  if (messagesError || !messages?.length) throw new Error("Não há mensagem para processar.");
  const latestCustomerMessage = [...messages].find((message) => message.direction === "incoming")?.body || "";
  const keywords = (agent.handoff_keywords || []).map((keyword) => clean(keyword).toLowerCase()).filter(Boolean);
  if (keywords.some((keyword) => clean(latestCustomerMessage).toLowerCase().includes(keyword))) {
    await supabase.from("agent_conversations").update({ status: "pending" }).eq("id", conversation.id).eq("organization_id", job.organization_id);
    return;
  }
  if (agent.max_replies_per_conversation > 0) {
    const sent = messages.filter((message) => message.direction === "outgoing").length;
    if (sent >= agent.max_replies_per_conversation) {
      await supabase.from("agent_conversations").update({ status: "pending" }).eq("id", conversation.id).eq("organization_id", job.organization_id);
      return;
    }
  }

  const context = await loadAgentContext(job.organization_id, agent);
  const reply = await answerWithGemini({ agent, messages: [...messages].reverse(), context });
  await sendEvolutionText(whatsapp, conversation.contact_phone, reply);
  const now = new Date().toISOString();
  const { error: insertError } = await supabase.from("agent_messages").insert({
    organization_id: job.organization_id, conversation_id: conversation.id, direction: "outgoing", sender_type: "agent", body: reply, message_type: "text", delivery_status: "sent", metadata: { provider: "evolution", model },
  });
  if (insertError) throw new Error("A resposta foi enviada, mas não pôde ser registrada.");
  await supabase.from("agent_conversations").update({ last_message_at: now, last_message_preview: reply.slice(0, 220), status: "open" }).eq("id", conversation.id).eq("organization_id", job.organization_id);
}

async function work() {
  await supabase.rpc("expire_influr_trials");
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
