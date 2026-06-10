const firebaseConfig = {
  apiKey: "AIzaSyD8Bzfq8zxwVj31D439fva-D1F6pPFC9po",
  authDomain: "fechamentodecaixa-ad353.firebaseapp.com",
  projectId: "fechamentodecaixa-ad353",
  storageBucket: "fechamentodecaixa-ad353.firebasestorage.app",
  messagingSenderId: "1038905206642",
  appId: "1:1038905206642:web:22b24d28c565fc9d229feb"
};

let db = null;
let auth = null;
try {
  if (window.firebase) {
    firebase.initializeApp(firebaseConfig);
    auth = firebase.auth ? firebase.auth() : null;
    db = firebase.firestore();
  }
} catch (error) {
  console.warn("Firebase indisponivel:", error);
}

let caixa = null;
let turnoAtual = "manha";
let saidas = [];
let vales = [];
let totaisEntradas = {};
let historico = loadJSON("caixa_historico", []);
let notificacoesGlobais = loadJSON("caixa_notificacoes", []);
let fechandoCaixa = false;
let saidaEditandoId = null;
let valeEditandoId = null;

const PAGAMENTOS = {
  dinheiro: "Dinheiro",
  credito: "Crédito",
  debito: "Débito",
  maquininha: "Maquininha",
  pix: "PIX"
};

document.addEventListener("DOMContentLoaded", () => {
  const hoje = isoHoje();
  setValue("data-abertura", hoje);
  setValue("data-fechamento", hoje);
  atualizarRelogio();
  setInterval(atualizarRelogio, 1000);
  carregarEstado();
  renderizarSaidas();
  renderizarVales();
  renderizarHistorico();
  renderizarPorDia();
  atualizarDashboard();
  renderizarNotificacoes();
  iniciarAuth();
});

function qs(id) {
  return document.getElementById(id);
}

function num(id) {
  return parseFloat(qs(id)?.value) || 0;
}

function setValue(id, value) {
  const el = qs(id);
  if (el) el.value = value ?? "";
}

function setText(id, value) {
  const el = qs(id);
  if (el) el.textContent = value;
}

function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function isoHoje() {
  return new Date().toISOString().slice(0, 10);
}

function dataBRFromISO(value) {
  return value ? new Date(value + "T00:00:00").toLocaleDateString("pt-BR") : new Date().toLocaleDateString("pt-BR");
}

function parseDataBR(data) {
  if (!data) return new Date(0);
  const [dia, mes, ano] = data.split("/");
  return new Date(`${ano}-${mes}-${dia}T00:00:00`);
}

function formatCurrency(value) {
  return (value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function atualizarRelogio() {
  const now = new Date();
  setText("sidebar-date", now.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short" }));
  setText("sidebar-time", now.toLocaleTimeString("pt-BR"));
}

async function carregarEstado() {
  const local = loadJSON("caixa_atual", null);
  if (local) aplicarEstado(local);

  if (!db) {
    // Deduplicação no caso offline (local)
    const vistosLocal = new Set();
    historico = historico.filter(item => {
      if (!item.id || vistosLocal.has(item.id)) return false;
      vistosLocal.add(item.id);
      return true;
    });
    localStorage.setItem("caixa_historico", JSON.stringify(historico));

    atualizarStatusBadge();
    restaurarCampos();
    return;
  }

  try {
    const doc = await db.collection("estado_atual").doc("caixa").get();
    if (doc.exists) aplicarEstado(doc.data());

    const histSnap = await db.collection("historico").orderBy("id", "desc").limit(100).get();
    const docsMapeados = histSnap.docs.map(item => ({ ...item.data(), firestoreDocId: item.id }));
    
    // Deduplicação inteligente de histórico por ID
    const vistos = new Set();
    historico = docsMapeados.filter(item => {
      if (!item.id || vistos.has(item.id)) return false;
      vistos.add(item.id);
      return true;
    });
    localStorage.setItem("caixa_historico", JSON.stringify(historico));
  } catch (error) {
    console.warn("Falha ao carregar Firebase:", error);
    
    // Fallback de deduplicação local se falhar a rede
    const vistosLocal = new Set();
    historico = historico.filter(item => {
      if (!item.id || vistosLocal.has(item.id)) return false;
      vistosLocal.add(item.id);
      return true;
    });
    localStorage.setItem("caixa_historico", JSON.stringify(historico));
  }

  atualizarStatusBadge();
  restaurarCampos();
  renderizarHistorico();
  renderizarPorDia();
  atualizarDashboard();
}

function migrarPagamentos(p) {
  if (!p) return {};
  const n = { ...p };
  if (n.maquininha_debito !== undefined)  { n.debito      = n.debito      || n.maquininha_debito;  delete n.maquininha_debito; }
  if (n.maquininha_credito !== undefined) { n.credito     = n.credito     || n.maquininha_credito; delete n.maquininha_credito; }
  if (n.maquininha_sicredi !== undefined) { n.maquininha  = n.maquininha  || n.maquininha_sicredi; delete n.maquininha_sicredi; }
  return n;
}

function aplicarEstado(data) {
  caixa = data?.caixa || null;
  saidas = data?.saidas || data?.saídas || [];
  vales = data?.vales || [];
  totaisEntradas = migrarPagamentos(data?.totaisEntradas || {});
  if (caixa?.turno) turnoAtual = caixa.turno;
}

async function salvarEstado() {
  const data = { caixa, saidas, vales, totaisEntradas };
  localStorage.setItem("caixa_atual", JSON.stringify(data));
  if (!db) return;
  try {
    await db.collection("estado_atual").doc("caixa").set(data);
  } catch (error) {
    console.warn("Falha ao salvar Firebase:", error);
  }
}

function restaurarCampos() {
  setValue("venda-bruta", totaisEntradas.vendaBruta || "");
  setValue("total-dinheiro", totaisEntradas.dinheiro || "");
  setValue("total-credito", totaisEntradas.credito || "");
  setValue("total-debito", totaisEntradas.debito || "");
  setValue("total-maquininha", totaisEntradas.maquininha || "");
  setValue("total-pix", totaisEntradas.pix || "");
  renderizarSaidas();
  renderizarVales();
}

function showView(view) {
  if ((view === "movimentos" || view === "fechamento") && !caixa) {
    showModal("modal-sem-caixa");
    view = "abertura";
  }

  document.querySelectorAll(".view").forEach(item => item.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(item => item.classList.remove("active"));
  document.querySelectorAll(".bottom-nav-item").forEach(item => item.classList.remove("active"));
  qs(`view-${view}`)?.classList.add("active");
  qs(`nav-${view}`)?.classList.add("active");
  qs(`bnav-${view}`)?.classList.add("active");

  const titles = {
    dashboard: "Dashboard",
    abertura: caixa ? "Configuracoes do Caixa" : "Abertura de Caixa",
    movimentos: "Movimentos",
    fechamento: "Fechar Caixa",
    historico: "Historico"
  };
  setText("page-title", titles[view] || view);

  if (view === "abertura") preencherAbertura();
  if (view === "movimentos") {
    const vendaBruta = qs("venda-bruta-container");
    if (vendaBruta) vendaBruta.style.display = caixa?.turno === "tarde" ? "block" : "none";
  }
  if (view === "fechamento") atualizarResumoFechamento();
  closeSidebar();
}

function toggleSidebar() {
  const sidebar = qs("sidebar");
  const backdrop = qs("sidebar-backdrop");
  sidebar?.classList.toggle("open");
  backdrop?.classList.toggle("show", sidebar?.classList.contains("open"));
}

function closeSidebar() {
  qs("sidebar")?.classList.remove("open");
  qs("sidebar-backdrop")?.classList.remove("show");
}

function setTurno(turno) {
  turnoAtual = turno;
  qs("turno-manha")?.classList.toggle("active", turno === "manha");
  qs("turno-tarde")?.classList.toggle("active", turno === "tarde");
}

function preencherAbertura() {
  const title = document.querySelector(".opening-card h2");
  const btn = qs("btn-abrir-caixa");
  if (!caixa) {
    if (title) title.textContent = "Abertura de Caixa";
    if (btn) btn.textContent = "Abrir Caixa";
    return;
  }

  if (title) title.textContent = "Editar Caixa Atual";
  if (btn) btn.textContent = "Salvar Alteracoes";
  setValue("saldo-inicial", caixa.saldoInicial || "");
  setValue("operador-nome", caixa.operador || "");
  setValue("obs-abertura", caixa.obs || "");
  setTurno(caixa.turno || "manha");
  if (caixa.dataISOAbertura) setValue("data-abertura", caixa.dataISOAbertura);
}

function abrirCaixa() {
  const saldoInicial = num("saldo-inicial");
  let obs = qs("obs-abertura")?.value.trim() || "";
  const operador = qs("operador-nome")?.value.trim() || "Operador";
  const dataISOAbertura = qs("data-abertura")?.value || isoHoje();
  const dataAbertura = dataBRFromISO(dataISOAbertura);

  if (caixa) {
    Object.assign(caixa, { saldoInicial, operador, obs, turno: turnoAtual, dataAbertura, dataISOAbertura });
    salvarEstado();
    atualizarStatusBadge();
    atualizarDashboard();
    showToast("Configuracoes do caixa atualizadas.", "success");
    showView("movimentos");
    return;
  }

  const ultimo = historico[0];
  if (ultimo && ultimo.saldoProximo != null) {
    const diff = saldoInicial - ultimo.saldoProximo;
    if (Math.abs(diff) > 0.01) {
      const msg = `Diferenca de caixa: ${formatCurrency(Math.abs(diff))} ${diff > 0 ? "A MAIS" : "A MENOS"} em relacao ao saldo anterior (${formatCurrency(ultimo.saldoProximo)}).`;
      obs = `${msg}\n${obs}`.trim();
      addNotificacao(msg, diff > 0 ? "success" : "error");
    }
  }

  caixa = {
    id: Date.now(),
    abertura: new Date().toISOString(),
    dataAbertura,
    dataISOAbertura,
    saldoInicial,
    operador,
    turno: turnoAtual,
    obs
  };
  saidas = [];
  vales = [];
  totaisEntradas = {};
  salvarEstado();
  restaurarCampos();
  atualizarStatusBadge();
  atualizarDashboard();
  showToast(`Caixa aberto - ${dataAbertura} - ${turnoAtual === "manha" ? "Manha" : "Tarde"}`, "success");
  showView("movimentos");
}

function atualizarStatusBadge() {
  const dot = document.querySelector(".status-dot");
  const txt = qs("status-text");
  if (!dot || !txt) return;
  dot.className = caixa ? "status-dot open" : "status-dot closed";
  txt.textContent = caixa ? `Caixa Aberto - ${caixa.turno === "manha" ? "Manha" : "Tarde"}` : "Caixa Fechado";
}

function salvarTotais() {
  if (!caixa) return;
  totaisEntradas = {
    vendaBruta: num("venda-bruta"),
    dinheiro: num("total-dinheiro"),
    credito: num("total-credito"),
    debito: num("total-debito"),
    maquininha: num("total-maquininha"),
    pix: num("total-pix")
  };
  salvarEstado();
  atualizarDashboard();
}

function adicionarRetirada() {
  salvarRetirada();
}

function salvarRetirada() {
  if (!caixa) return showModal("modal-sem-caixa");
  const valor = num("ret-valor");
  const descricao = qs("ret-descricao")?.value.trim();
  const categoria = qs("ret-categoria")?.value || "retirada";
  if (valor <= 0) return showToast("Informe um valor valido.", "error");

  if (saidaEditandoId) {
    const saida = saidas.find(item => item.id === saidaEditandoId);
    if (!saida) return cancelarEdicaoRetirada();
    Object.assign(saida, { valor, descricao: descricao || categoria, categoria });
    showToast("Lancamento atualizado.", "success");
  } else {
    saidas.push({
      id: Date.now(),
      hora: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
      valor,
      descricao: descricao || categoria,
      categoria
    });
  }

  setValue("ret-valor", "");
  setValue("ret-descricao", "");
  saidaEditandoId = null;
  atualizarBotoesEdicao();
  salvarEstado();
  renderizarSaidas();
  atualizarDashboard();
}

function adicionarVale() {
  salvarVale();
}

function salvarVale() {
  if (!caixa) return showModal("modal-sem-caixa");
  const nome = qs("vale-nome")?.value.trim();
  const obs = qs("vale-obs")?.value.trim();
  const valor = num("vale-valor");
  if (!nome) return showToast("Informe o nome do funcionario.", "error");
  if (valor <= 0) return showToast("Informe um valor valido.", "error");

  if (valeEditandoId) {
    const vale = vales.find(item => item.id === valeEditandoId);
    if (!vale) return cancelarEdicaoVale();
    Object.assign(vale, { nome, obs, valor });
    showToast("Vale atualizado.", "success");
  } else {
    vales.push({ id: Date.now(), nome, obs, valor });
  }

  setValue("vale-nome", "");
  setValue("vale-obs", "");
  setValue("vale-valor", "");
  valeEditandoId = null;
  atualizarBotoesEdicao();
  salvarEstado();
  renderizarVales();
  atualizarDashboard();
}

function editarSaida(id) {
  const saida = saidas.find(item => item.id === id);
  if (!saida) return;
  saidaEditandoId = id;
  setValue("ret-categoria", saida.categoria);
  setValue("ret-valor", saida.valor);
  setValue("ret-descricao", saida.descricao);
  atualizarBotoesEdicao();
  qs("ret-descricao")?.focus();
}

function cancelarEdicaoRetirada() {
  saidaEditandoId = null;
  setValue("ret-valor", "");
  setValue("ret-descricao", "");
  atualizarBotoesEdicao();
}

function editarVale(id) {
  const vale = vales.find(item => item.id === id);
  if (!vale) return;
  valeEditandoId = id;
  setValue("vale-nome", vale.nome);
  setValue("vale-obs", vale.obs);
  setValue("vale-valor", vale.valor);
  atualizarBotoesEdicao();
  qs("vale-nome")?.focus();
}

function cancelarEdicaoVale() {
  valeEditandoId = null;
  setValue("vale-nome", "");
  setValue("vale-obs", "");
  setValue("vale-valor", "");
  atualizarBotoesEdicao();
}

function atualizarBotoesEdicao() {
  const btnRetirada = qs("btn-retirada");
  const cancelRetirada = qs("btn-cancelar-retirada");
  const btnVale = qs("btn-vale");
  const cancelVale = qs("btn-cancelar-vale");
  if (btnRetirada) btnRetirada.textContent = saidaEditandoId ? "Salvar Alteracao" : "Adicionar";
  if (cancelRetirada) cancelRetirada.style.display = saidaEditandoId ? "inline-flex" : "none";
  if (btnVale) btnVale.textContent = valeEditandoId ? "Salvar Alteracao" : "Lancar Vale";
  if (cancelVale) cancelVale.style.display = valeEditandoId ? "inline-flex" : "none";
}

function removerSaida(id) {
  if (saidaEditandoId === id) cancelarEdicaoRetirada();
  saidas = saidas.filter(item => item.id !== id);
  salvarEstado();
  renderizarSaidas();
  atualizarDashboard();
}

function removerVale(id) {
  if (valeEditandoId === id) cancelarEdicaoVale();
  vales = vales.filter(item => item.id !== id);
  salvarEstado();
  renderizarVales();
  atualizarDashboard();
}

function calcularTotais() {
  const saldoInicial = caixa?.saldoInicial || 0;
  const dinheiroNoCaixa = totaisEntradas.dinheiro || 0;
  const totalSaidas = saidas.reduce((sum, item) => sum + item.valor, 0);

  // REMOVIDO o - saldoInicial
  const vendasDinheiro = Math.max(0, dinheiroNoCaixa + totalSaidas);

  const outrasEntradas =
    (totaisEntradas.pix || 0) +
    (totaisEntradas.debito || 0) +
    (totaisEntradas.credito || 0) +
    (totaisEntradas.maquininha || 0);

  const totalVales = vales.reduce((sum, item) => sum + item.valor, 0);

  const sangrias = saidas
    .filter(item => item.categoria === "sangria")
    .reduce((sum, item) => sum + item.valor, 0);

  const retiradas = saidas
    .filter(item => item.categoria === "retirada")
    .reduce((sum, item) => sum + item.valor, 0);

  return {
    vendaBruta: totaisEntradas.vendaBruta || 0,
    entradas: vendasDinheiro + outrasEntradas,
    saidas: totalSaidas,
    sangrias,
    retiradas,
    vales: totalVales,

    // Caixa final sem descontar abertura
    saldoFinal: dinheiroNoCaixa
  };
}

function atualizarDashboard() {
  const t = calcularTotais();
  const pagamentosDashboard = calcularPagamentosDashboard();
  setText("resumo-total-entradas", formatCurrency(t.entradas));
  setText("resumo-saldo", formatCurrency(t.saldoFinal));
  setText("resumo-total-saidas", formatCurrency(t.saidas));
  setText("resumo-total-vales", formatCurrency(t.vales));

  // Atualizar resumo do caixa na tela de Movimentos
  setText("resumo-total-entradas-mov", formatCurrency(t.entradas));
  setText("resumo-saidas-mov", formatCurrency(t.saidas));
  setText("resumo-saldo-mov", formatCurrency(t.saldoFinal));
  setText("pb-dinheiro", formatCurrency(pagamentosDashboard.dinheiro));
  setText("pb-credito", formatCurrency(pagamentosDashboard.credito));
  setText("pb-debito", formatCurrency(pagamentosDashboard.debito));
  setText("pb-maquininha", formatCurrency(pagamentosDashboard.maquininha));
  setText("pb-pix", formatCurrency(pagamentosDashboard.pix));
  setText("pb-vale_funcionario", formatCurrency(pagamentosDashboard.vales));
  setText("pb-sangrias", formatCurrency(pagamentosDashboard.saidas));

  // Barra de progresso relativa nos pagamentos
  const maxPag = Math.max(
    pagamentosDashboard.dinheiro, pagamentosDashboard.credito,
    pagamentosDashboard.debito, pagamentosDashboard.maquininha,
    pagamentosDashboard.pix, pagamentosDashboard.vales, pagamentosDashboard.saidas, 1
  );
  const setPct = (id, val) => {
    const row = qs(id)?.closest(".payment-row");
    if (row) row.style.setProperty("--pct", (val / maxPag * 100).toFixed(1) + "%");
  };
  setPct("pb-dinheiro", pagamentosDashboard.dinheiro);
  setPct("pb-credito", pagamentosDashboard.credito);
  setPct("pb-debito", pagamentosDashboard.debito);
  setPct("pb-maquininha", pagamentosDashboard.maquininha);
  setPct("pb-pix", pagamentosDashboard.pix);
  setPct("pb-vale_funcionario", pagamentosDashboard.vales);
  setPct("pb-sangrias", pagamentosDashboard.saidas);

  renderizarRecentes();
  renderizarGraficoVendas15Dias();

  const mesAtual = isoHoje().slice(0, 7);
  let vendasMes = 0;
  let recebidoMes = 0;
  let retiradasMes = 0;
  let gastosMes = 0;

  historico.forEach(item => {
    if (caixa && (caixa.idOriginal === item.id || caixa.id === item.id)) return;
    const mes = getMesFechamento(item);
    if (mes !== mesAtual) return;
    const p = migrarPagamentos(item.porPagamento || {});
    vendasMes += item.vendaBruta || 0;
    recebidoMes += (p.pix || 0) + (p.debito || 0) + (p.credito || 0) + (p.maquininha || 0);
    retiradasMes += (item.retiradas || 0) + (item.sangrias || 0) + (item.retiradaFinal || 0);
    gastosMes += calcularGastosLista([...(item.listaSaidas || []), ...(item.movimentos || [])]);
  });

  setText("dash-mes-vendas", formatCurrency(vendasMes));
  setText("dash-mes-recebido", formatCurrency(recebidoMes));
  setText("dash-mes-retiradas", formatCurrency(retiradasMes));
  setText("dash-mes-gastos", formatCurrency(gastosMes));
}

function getMesFechamento(item) {
  if (item.dataISO) return item.dataISO.slice(0, 7);
  if (item.data) {
    const partes = item.data.split("/");
    if (partes.length === 3) return `${partes[2]}-${partes[1].padStart(2, "0")}`;
  }
  return "";
}

function calcularGastosLista(lista) {
  const categoriasGasto = ["despesa", "fornecedor", "retirada", "outro_saida", "gasto"];
  return lista
    .filter(item => {
      const categoria = normalizarTexto(item.categoria || item.tipo || "");
      const descricao = normalizarTexto(item.descricao || item.obs || "");
      return categoriasGasto.includes(categoria) || categoriasGasto.some(c => descricao.includes(c.replace("_", " ")));
    })
    .reduce((sum, item) => sum + parseValor(item.valor), 0);
}

function normalizarTexto(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function parseValor(value) {
  if (typeof value === "number") return value;
  const parsed = parseFloat(String(value || "0").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function calcularPagamentosDashboard() {
  const mesAtual = isoHoje().slice(0, 7);
  const totais = {
    dinheiro: 0,
    pix: 0,
    debito: 0,
    credito: 0,
    maquininha: 0,
    vales: 0,
    saidas: 0
  };

  historico.forEach(item => {
    if (caixa && (caixa.idOriginal === item.id || caixa.id === item.id)) return;
    const mes = item.dataISO ? item.dataISO.slice(0, 7) : "";
    if (mes !== mesAtual) return;
    const p = migrarPagamentos(item.porPagamento || {});
    totais.dinheiro += p.dinheiro || 0;
    totais.pix += p.pix || 0;
    totais.debito += p.debito || 0;
    totais.credito += p.credito || 0;
    totais.maquininha += p.maquininha || 0;
    totais.vales += item.vales || 0;
    totais.saidas += item.saidas || item.saídas || 0;
  });

  if (caixa) {
    const atual = calcularTotais();
    totais.dinheiro += totaisEntradas.dinheiro || 0;
    totais.pix += totaisEntradas.pix || 0;
    totais.debito += totaisEntradas.debito || 0;
    totais.credito += totaisEntradas.credito || 0;
    totais.maquininha += totaisEntradas.maquininha || 0;
    totais.vales += atual.vales;
    totais.saidas += atual.saidas;
  }

  return totais;
}

function renderizarGraficoVendas15Dias() {
  const container = qs("sales-chart");
  if (!container) return;

  const dias = [];
  for (let i = 14; i >= 0; i--) {
    const data = new Date();
    data.setDate(data.getDate() - i);
    const iso = data.toISOString().slice(0, 10);
    dias.push({
      iso,
      label: data.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }),
      valor: 0
    });
  }

  historico.forEach(item => {
    if (caixa && (caixa.idOriginal === item.id || caixa.id === item.id)) return;
    const iso = item.dataISO ? item.dataISO.slice(0, 10) : null;
    const dia = dias.find(d => d.iso === iso);
    if (dia) dia.valor += item.vendaBruta || 0;
  });

  if (caixa) {
    const iso = caixa.dataISOAbertura || isoHoje();
    const dia = dias.find(d => d.iso === iso);
    if (dia) dia.valor += totaisEntradas.vendaBruta || 0;
  }

  const maiorValor = Math.max(...dias.map(d => d.valor), 1);
  const totalPeriodo = dias.reduce((sum, dia) => sum + dia.valor, 0);
  const hoje = isoHoje();

  container.innerHTML = `
    <div class="chart-summary">
      <span>Total no período</span>
      <strong>${formatCurrency(totalPeriodo)}</strong>
    </div>
    <div class="chart-bars">
      ${dias.map(dia => {
        const altura = Math.max(4, Math.round((dia.valor / maiorValor) * 100));
        const isHoje = dia.iso === hoje;
        return `
          <div class="chart-bar-item${isHoje ? " hoje" : ""}" title="${dia.label} - ${formatCurrency(dia.valor)}">
            <div class="chart-bar-value">${dia.valor > 0 ? formatCurrency(dia.valor) : ""}</div>
            <div class="chart-bar-track"><div class="chart-bar-fill" style="height:${altura}%"></div></div>
            <div class="chart-bar-label">${isHoje ? "Hoje" : dia.label}</div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderizarSaidas() {
  const tbody = qs("ret-tbody");
  if (!tbody) return;
  if (!saidas.length) {
    tbody.innerHTML = '<tr class="tr-empty"><td colspan="5"><div class="empty-state"><p>Nenhuma saída registrada</p></div></td></tr>';
    return;
  }
  tbody.innerHTML = saidas.map(item => `
    <tr>
      <td data-label="Hora">${escapeHTML(item.hora)}</td>
      <td data-label="Descrição">${escapeHTML(item.descricao)}</td>
      <td data-label="Tipo">${escapeHTML(item.categoria)}</td>
      <td data-label="Valor">${formatCurrency(item.valor)}</td>
      <td data-label="actions">
        <button class="btn btn-outline btn-sm" onclick="editarSaida(${item.id})">Editar</button>
        <button class="btn-icon" onclick="removerSaida(${item.id})" title="Remover">🗑</button>
      </td>
    </tr>
  `).join("");
}

function renderizarVales() {
  const tbody = qs("vale-tbody");
  if (!tbody) return;
  if (!vales.length) {
    tbody.innerHTML = '<tr class="tr-empty"><td colspan="4"><div class="empty-state"><p>Nenhum vale lançado</p></div></td></tr>';
    return;
  }
  tbody.innerHTML = vales.map(item => `
    <tr>
      <td data-label="Funcionário">${escapeHTML(item.nome)}</td>
      <td data-label="Observação">${escapeHTML(item.obs || "-")}</td>
      <td data-label="Valor">${formatCurrency(item.valor)}</td>
      <td data-label="actions">
        <button class="btn btn-outline btn-sm" onclick="editarVale(${item.id})">Editar</button>
        <button class="btn-icon" onclick="removerVale(${item.id})" title="Remover">🗑</button>
      </td>
    </tr>
  `).join("");
}

function renderizarRecentes() {
  const cont = qs("recent-movements");
  if (!cont) return;
  const itens = [
    ...saidas.map(item => ({ ...item, tipo: "saida", catClass: `cat-${item.categoria || "outro"}` })),
    ...vales.map(item => ({ id: item.id, hora: "-", descricao: `Vale: ${item.nome}`, categoria: item.obs || "Vale", valor: item.valor, tipo: "saida", catClass: "cat-vale" }))
  ].sort((a, b) => b.id - a.id).slice(0, 5);

  if (!itens.length) {
    cont.innerHTML = '<div class="empty-state"><p>Nenhum movimento registrado</p></div>';
    return;
  }
  cont.innerHTML = itens.map(item => `
    <div class="movement-item ${escapeHTML(item.catClass)}">
      <div class="movement-info">
        <span class="movement-desc">${escapeHTML(item.descricao)}</span>
        <span class="movement-meta">${escapeHTML(item.categoria)}</span>
      </div>
      <span class="movement-amount ${item.tipo}">-${formatCurrency(item.valor)}</span>
    </div>
  `).join("");
}

function atualizarResumoFechamento() {
  const t = calcularTotais();
  setText("fech-saldo-inicial", formatCurrency(caixa?.saldoInicial || 0));
  setText("fech-entradas", formatCurrency(t.entradas));
  setText("fech-saidas", formatCurrency(t.saidas));
  setText("fech-total", formatCurrency(t.saldoFinal));
  setText("fech-dinheiro", formatCurrency(totaisEntradas.dinheiro || 0));
  setText("fech-credito", formatCurrency(totaisEntradas.credito || 0));
  setText("fech-debito", formatCurrency(totaisEntradas.debito || 0));
  setText("fech-maquininha", formatCurrency(totaisEntradas.maquininha || 0));
  setText("fech-pix", formatCurrency(totaisEntradas.pix || 0));
  setText("fech-vale_funcionario", formatCurrency(t.vales));
  setText("fech-sangrias", formatCurrency(t.sangrias));
  setText("fech-retiradas", formatCurrency(t.retiradas));
  setValue("fech-retirada-final", caixa?.retiradaFinal ? caixa.retiradaFinal.toFixed(2) : "");
  setValue("fech-saldo-proximo", "");
  qs("diff-alert-fech")?.classList.remove("show");
}

function calcularManualFechamento(origem) {
  const dinheiro = totaisEntradas.dinheiro || 0;
  const campoRetirada = qs("fech-retirada-final");
  const campoSaldo = qs("fech-saldo-proximo");
  if (!campoRetirada || !campoSaldo) return;
  if (origem === "retirada") campoSaldo.value = Math.max(0, dinheiro - (parseFloat(campoRetirada.value) || 0)).toFixed(2);
  if (origem === "saldo") campoRetirada.value = Math.max(0, dinheiro - (parseFloat(campoSaldo.value) || 0)).toFixed(2);

  const total = (parseFloat(campoRetirada.value) || 0) + (parseFloat(campoSaldo.value) || 0);
  const alert = qs("diff-alert-fech");
  const msg = qs("diff-alert-msg");
  if (!alert || !msg) return;
  if (Math.abs(total - dinheiro) > 0.01) {
    alert.className = "diff-alert show negativo";
    msg.textContent = "Os valores nao batem com o dinheiro em caixa.";
  } else {
    alert.classList.remove("show");
  }
}

async function fecharCaixa() {
  if (!caixa) return showModal("modal-sem-caixa");
  if (fechandoCaixa) return;
  fechandoCaixa = true;

  const t = calcularTotais();
  const dataISO = qs("data-fechamento")?.value || isoHoje();
  const registro = {
    id: caixa.idOriginal || Date.now(),
    data: dataBRFromISO(dataISO),
    dataISO: new Date(dataISO + "T00:00:00").toISOString(),
    dataAbertura: caixa.dataAbertura,
    turno: caixa.turno,
    operador: caixa.operador,
    saldoInicial: caixa.saldoInicial,
    vendaBruta: t.vendaBruta,
    entradas: t.entradas,
    saidas: t.saidas,
    sangrias: t.sangrias,
    retiradas: t.retiradas,
    vales: t.vales,
    listaSaidas: [...saidas],
    listaVales: [...vales],
    porPagamento: { ...totaisEntradas },
    saldoFinal: t.saldoFinal,
    retiradaFinal: num("fech-retirada-final"),
    saldoProximo: qs("fech-saldo-proximo")?.value ? num("fech-saldo-proximo") : null,
    obs: qs("fech-obs")?.value.trim() || ""
  };

  try {
    if (db) {
      let docRef = null;
      if (caixa.firestoreDocId) {
        docRef = db.collection("historico").doc(caixa.firestoreDocId);
      } else {
        // Busca se já existe um documento com o mesmo ID único do caixa
        const querySnap = await db.collection("historico").where("id", "==", registro.id).limit(1).get();
        if (!querySnap.empty) {
          docRef = querySnap.docs[0].ref;
        } else {
          // Se não existir, cria o documento com ID idêntico ao registro.id
          docRef = db.collection("historico").doc(String(registro.id));
        }
      }
      await docRef.set(registro);
      await db.collection("estado_atual").doc("caixa").delete();
    }
    historico = historico.filter(item => item.id !== registro.id);
    historico.unshift(registro);
    historico.sort((a, b) => b.id - a.id);
    localStorage.setItem("caixa_historico", JSON.stringify(historico));
    localStorage.removeItem("caixa_atual");
    caixa = null;
    saidas = [];
    vales = [];
    totaisEntradas = {};
    document.querySelectorAll('input[type="number"]').forEach(input => input.value = "");
    setValue("data-abertura", isoHoje());
    setValue("data-fechamento", isoHoje());
    setValue("fech-obs", "");
    atualizarStatusBadge();
    restaurarCampos();
    atualizarDashboard();
    renderizarHistorico();
    renderizarPorDia();
    closeModal("modal-fechamento");
    showToast("Caixa fechado e salvo no historico.", "success");
    showView("historico");
  } catch (error) {
    console.error(error);
    showToast("Erro ao salvar. Os dados continuam no caixa atual.", "error");
  } finally {
    fechandoCaixa = false;
  }
}

function renderizarHistorico(lista = historico) {
  const cont = qs("historico-list");
  if (!cont) return;
  if (!lista.length) {
    cont.innerHTML = '<div class="empty-state large"><h3>Nenhum fechamento registrado</h3><p>Os fechamentos aparecerao aqui.</p></div>';
    return;
  }
  cont.innerHTML = lista.map(item => {
    const turnoClass = item.turno === "manha" ? "turno-manha" : "turno-tarde";
    const turnoLabel = item.turno === "manha" ? "☀️ Manhã" : "🌙 Tarde";
    return `
    <div class="historico-item ${turnoClass}">
      <div style="flex:1;min-width:0;">
        <div class="historico-data">${escapeHTML(item.data)} <span style="font-weight:500;color:var(--text2);font-size:.85rem;">${turnoLabel}</span></div>
        <div class="historico-op">Operador: ${escapeHTML(item.operador || "-")}</div>
        <div class="historico-op" style="margin-top:.25rem;">
          <span style="color:var(--green);font-weight:600;">+${formatCurrency(item.entradas)}</span>
          <span style="color:var(--text3);margin:0 .35rem;">·</span>
          <span style="color:var(--red);font-weight:600;">-${formatCurrency(item.saidas)}</span>
        </div>
        ${item.saldoProximo != null ? `<div class="historico-op" style="color:var(--blue);margin-top:.15rem;">→ Próximo: ${formatCurrency(item.saldoProximo)}</div>` : ""}
      </div>
      <div class="historico-vals">
        <div class="historico-total">${formatCurrency(item.saldoFinal)}</div>
        <div class="historico-detail">saldo final</div>
        <div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.5rem;">
          <button class="btn btn-outline btn-sm" onclick="reabrirFechamento(${item.id})">Editar</button>
          <button class="btn btn-outline btn-sm" onclick="enviarWhatsApp(${item.id})">WhatsApp</button>
          <button class="btn btn-outline btn-sm" onclick="imprimirHistorico(${item.id})">Imprimir</button>
          <button class="btn btn-danger btn-sm" onclick="excluirFechamento(${item.id})">Excluir</button>
        </div>
      </div>
    </div>
  `;
  }).join("");
}

function getHistoricoFiltrado() {
  const ini = qs("filtro-data-ini")?.value;
  const fim = qs("filtro-data-fim")?.value;
  const turno = qs("filtro-turno")?.value;
  return historico.filter(item => {
    const data = item.dataISO ? new Date(item.dataISO) : parseDataBR(item.data);
    if (ini && data < new Date(ini + "T00:00:00")) return false;
    if (fim && data > new Date(fim + "T23:59:59")) return false;
    if (turno && item.turno !== turno) return false;
    return true;
  });
}

function filtrarHistorico() {
  const filtrado = getHistoricoFiltrado();
  const total = filtrado.reduce((sum, item) => sum + (item.saldoFinal || 0), 0);
  setText("filter-summary", filtrado.length ? `${filtrado.length} resultado(s) - Total: ${formatCurrency(total)}` : "Nenhum resultado");
  renderizarHistorico(filtrado);
  if (qs("hist-quebra")?.style.display    !== "none") renderizarQuebraSobra();
  if (qs("hist-retiradas")?.style.display !== "none") renderizarRetiradas();
}

function limparFiltro() {
  setValue("filtro-data-ini", "");
  setValue("filtro-data-fim", "");
  setValue("filtro-turno", "");
  setText("filter-summary", "");
  renderizarHistorico();
}

async function excluirFechamento(id) {
  const item = historico.find(fechamento => fechamento.id === id);
  if (!item) return showToast("Fechamento nao encontrado.", "error");

  const data = item.data || "-";
  const turno = item.turno === "manha" ? "Manha" : "Tarde";
  if (!confirm(`Excluir o fechamento de ${data} (${turno})? Esta acao nao pode ser desfeita.`)) return;

  try {
    if (db && item.firestoreDocId) {
      await db.collection("historico").doc(item.firestoreDocId).delete();
    } else if (db) {
      const docs = await db.collection("historico").where("id", "==", id).get();
      const exclusoes = [];
      docs.forEach(doc => exclusoes.push(doc.ref.delete()));
      await Promise.all(exclusoes);
    }

    historico = historico.filter(fechamento => fechamento.id !== id);
    localStorage.setItem("caixa_historico", JSON.stringify(historico));
    renderizarHistorico();
    renderizarPorDia();
    atualizarDashboard();
    showToast("Fechamento excluido.", "success");
  } catch (error) {
    console.error(error);
    showToast("Nao foi possivel excluir o fechamento.", "error");
  }
}

function reabrirFechamento(id) {
  if (caixa) {
    showToast("Feche o caixa atual antes de editar um fechamento antigo.", "error");
    return;
  }

  const item = historico.find(fechamento => fechamento.id === id);
  if (!item) return showToast("Fechamento nao encontrado.", "error");
  if (!confirm("Deseja editar este fechamento? Ele voltara para a tela de lancamentos.")) return;

  caixa = {
    idOriginal: item.id,
    firestoreDocId: item.firestoreDocId,
    abertura: item.dataISO || new Date().toISOString(),
    dataAbertura: item.dataAbertura || item.data,
    dataISOAbertura: item.dataISOAbertura || (item.dataISO ? item.dataISO.slice(0, 10) : isoHoje()),
    saldoInicial: item.saldoInicial || 0,
    operador: item.operador || "Operador",
    turno: item.turno || "manha",
    obs: item.obs || "",
    retiradaFinal: item.retiradaFinal || 0
  };
  turnoAtual = caixa.turno;
  saidas = [...(item.listaSaidas || [])];
  vales = [...(item.listaVales || [])];
  totaisEntradas = migrarPagamentos(item.porPagamento || {});
  saidaEditandoId = null;
  valeEditandoId = null;

  setValue("data-fechamento", item.dataISO ? item.dataISO.slice(0, 10) : isoHoje());
  setValue("fech-obs", item.obs || "");
  salvarEstado();
  restaurarCampos();
  atualizarStatusBadge();
  atualizarDashboard();
  showToast("Fechamento reaberto para edicao.", "success");
  showView("movimentos");
}

function renderizarPorDia() {
  const cont = qs("pordia-list");
  if (!cont) return;
  if (!historico.length) {
    cont.innerHTML = '<div class="empty-state large"><h3>Nenhum dado disponivel</h3></div>';
    return;
  }
  const porDia = {};
  historico.forEach(item => {
    if (!porDia[item.data]) porDia[item.data] = { data: item.data, turnos: [], entradas: 0, saidas: 0, vendas: 0 };
    porDia[item.data].turnos.push(item);
    porDia[item.data].entradas += item.entradas || 0;
    porDia[item.data].saidas += item.saidas || 0;
    porDia[item.data].vendas += item.vendaBruta || 0;
  });
  cont.innerHTML = Object.values(porDia).map(dia => `
    <div class="pordia-card">
      <div class="pordia-header"><span class="pordia-data">${escapeHTML(dia.data)}</span><span class="pordia-total">${formatCurrency(dia.vendas)}</span></div>
      <div class="pordia-turnos">${dia.turnos.map(t => `<div class="pordia-turno"><span>${t.turno === "manha" ? "Manha" : "Tarde"} - ${escapeHTML(t.operador || "-")}</span><span>${formatCurrency(t.saldoFinal)}</span></div>`).join("")}</div>
      <div class="pordia-footer">Entradas: ${formatCurrency(dia.entradas)} | Saidas: ${formatCurrency(dia.saidas)}</div>
    </div>
  `).join("");
}

function setHistTab(tab) {
  qs("hist-fechamentos").style.display  = tab === "fechamentos" ? "block" : "none";
  qs("hist-pordia").style.display       = tab === "pordia"      ? "block" : "none";
  qs("hist-quebra").style.display       = tab === "quebra"      ? "block" : "none";
  qs("hist-retiradas").style.display    = tab === "retiradas"   ? "block" : "none";
  qs("htab-fechamentos")?.classList.toggle("active", tab === "fechamentos");
  qs("htab-pordia")?.classList.toggle("active", tab === "pordia");
  qs("htab-quebra")?.classList.toggle("active", tab === "quebra");
  qs("htab-retiradas")?.classList.toggle("active", tab === "retiradas");
  if (tab === "pordia")    renderizarPorDia();
  if (tab === "quebra")    renderizarQuebraSobra();
  if (tab === "retiradas") renderizarRetiradas();
}

function renderizarQuebraSobra() {
  const cont = qs("quebra-list");
  if (!cont) return;

  // Ordena cronologicamente pelo id (timestamp de fechamento)
  const todos = [...historico].sort((a, b) => a.id - b.id);

  // Aplica o filtro de data/turno ao turno sendo avaliado (o atual)
  const filtrados = new Set(getHistoricoFiltrado().map(i => i.id));

  const linhas = [];
  let totalSobra  = 0;
  let totalQuebra = 0;

  for (let i = 1; i < todos.length; i++) {
    const anterior = todos[i - 1];
    const atual    = todos[i];

    // Só mostra se o turno atual passou no filtro
    if (!filtrados.has(atual.id)) continue;

    // saldoProximo = o que o turno anterior deixou para o próximo
    const esperado  = anterior.saldoProximo;
    const declarado = atual.saldoInicial || 0;

    // Se o turno anterior não informou saldo próximo, não há como calcular
    if (esperado == null) {
      linhas.push({ atual, anterior, esperado: null, declarado, dif: null });
      continue;
    }

    const dif = declarado - esperado;
    if (dif > 0.009)  totalSobra  += dif;
    if (dif < -0.009) totalQuebra += Math.abs(dif);
    linhas.push({ atual, anterior, esperado, declarado, dif });
  }

  if (!linhas.length) {
    cont.innerHTML = '<div class="empty-state large"><h3>Nenhuma abertura para comparar</h3><p>São necessários pelo menos 2 fechamentos consecutivos com saldo informado.</p></div>';
    return;
  }

  const saldoLiq = totalSobra - totalQuebra;
  const corSaldo = saldoLiq >= 0 ? "var(--green)" : "var(--red)";

  const thStyle = `padding:.5rem .75rem;font-size:.72rem;color:var(--text3);font-weight:600;text-transform:uppercase;white-space:nowrap;`;

  const rows = linhas.map(({ atual, anterior, esperado, declarado, dif }) => {
    let difCell;
    if (esperado == null) {
      difCell = `<span style="color:var(--text3);font-size:.8rem;">Sem saldo próximo</span>`;
    } else {
      const cor   = dif >  0.009 ? "var(--green)" : dif < -0.009 ? "var(--red)" : "var(--text3)";
      const label = dif >  0.009 ? "▲ A mais"     : dif < -0.009 ? "▼ Quebra"   : "Zerado";
      difCell = `<span style="font-weight:800;color:${cor};">${formatCurrency(Math.abs(dif))}</span>
                 <span style="font-size:.72rem;color:${cor};margin-left:.3rem;">${label}</span>`;
    }
    return `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:.55rem .75rem;font-size:.84rem;">${escapeHTML(atual.data)}</td>
      <td style="padding:.55rem .75rem;font-size:.84rem;">${atual.turno === "manha" ? "Manhã" : "Tarde"}</td>
      <td style="padding:.55rem .75rem;font-size:.84rem;">${escapeHTML(atual.operador || "—")}</td>
      <td style="padding:.55rem .75rem;font-size:.84rem;color:var(--text3);">${escapeHTML(anterior.data)} · ${anterior.turno === "manha" ? "M" : "T"}</td>
      <td style="padding:.55rem .75rem;font-size:.84rem;text-align:right;">${esperado != null ? formatCurrency(esperado) : '<span style="color:var(--text3)">—</span>'}</td>
      <td style="padding:.55rem .75rem;font-size:.84rem;text-align:right;">${formatCurrency(declarado)}</td>
      <td style="padding:.55rem .75rem;font-size:.84rem;text-align:right;">${difCell}</td>
    </tr>`;
  }).join("");

  cont.innerHTML = `
    <div class="card" style="margin-bottom:1rem;">
      <div class="card-header"><h2>Resumo do período</h2></div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;padding:.25rem 1rem 1rem;">
        <div style="text-align:center;">
          <div style="font-size:.72rem;color:var(--text3);margin-bottom:.3rem;text-transform:uppercase;letter-spacing:.04em;">Total A Mais</div>
          <div style="font-size:1.1rem;font-weight:800;color:var(--green);">${formatCurrency(totalSobra)}</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:.72rem;color:var(--text3);margin-bottom:.3rem;text-transform:uppercase;letter-spacing:.04em;">Total Quebra</div>
          <div style="font-size:1.1rem;font-weight:800;color:var(--red);">${formatCurrency(totalQuebra)}</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:.72rem;color:var(--text3);margin-bottom:.3rem;text-transform:uppercase;letter-spacing:.04em;">Saldo Líquido</div>
          <div style="font-size:1.1rem;font-weight:800;color:${corSaldo};">${saldoLiq >= 0 ? "+" : "−"}${formatCurrency(Math.abs(saldoLiq))}</div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><h2>Quebra de Abertura por Turno</h2></div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="border-bottom:2px solid var(--border);">
              <th style="text-align:left;${thStyle}">Data Abertura</th>
              <th style="text-align:left;${thStyle}">Turno</th>
              <th style="text-align:left;${thStyle}">Operador</th>
              <th style="text-align:left;${thStyle}">Turno Anterior</th>
              <th style="text-align:right;${thStyle}">Saldo Esperado</th>
              <th style="text-align:right;${thStyle}">Saldo Declarado</th>
              <th style="text-align:right;${thStyle}">Diferença</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function renderizarRetiradas() {
  const cont = qs("retiradas-list");
  if (!cont) return;

  const lista = getHistoricoFiltrado();
  if (!lista.length) {
    cont.innerHTML = '<div class="empty-state large"><h3>Nenhum dado disponível</h3><p>Os fechamentos aparecerão aqui.</p></div>';
    return;
  }

  const LABEL = { retirada: "Retirada", sangria: "Sangria", despesa: "Despesa", retirada_final: "Retirada Final" };
  const COR   = { retirada: "var(--amber)", sangria: "var(--red)", despesa: "var(--purple)", retirada_final: "var(--blue)" };

  const totais = { retirada: 0, sangria: 0, despesa: 0, retirada_final: 0 };
  let totalExcesso = 0;
  const linhas = [];

  lista.forEach(item => {
    const dinheiroCaixa = item.saldoFinal || 0;

    (item.listaSaidas || []).forEach(s => {
      const cat = s.categoria || "retirada";
      totais[cat] = (totais[cat] || 0) + (s.valor || 0);
      linhas.push({
        data: item.data, dataISO: item.dataISO, turno: item.turno, operador: item.operador,
        hora: s.hora || "—", categoria: cat,
        descricao: s.descricao || LABEL[cat] || cat,
        valor: s.valor || 0, dinheiroCaixa: null, excesso: null
      });
    });

    if (item.retiradaFinal > 0) {
      totais.retirada_final += item.retiradaFinal;
      // Calcula excesso: retirada final > dinheiro em caixa
      const excesso = item.retiradaFinal - dinheiroCaixa;
      if (excesso > 0.009) totalExcesso += excesso;
      linhas.push({
        data: item.data, dataISO: item.dataISO, turno: item.turno, operador: item.operador,
        hora: "Fechamento", categoria: "retirada_final",
        descricao: "Retirada Final",
        valor: item.retiradaFinal, dinheiroCaixa, excesso: excesso > 0.009 ? excesso : null
      });
    }
  });

  if (!linhas.length) {
    cont.innerHTML = '<div class="empty-state large"><h3>Nenhuma retirada no período</h3></div>';
    return;
  }

  linhas.sort((a, b) => (b.dataISO || b.data) > (a.dataISO || a.data) ? 1 : -1);

  const totalGeral = Object.values(totais).reduce((s, v) => s + v, 0);
  const thStyle = `padding:.5rem .75rem;font-size:.72rem;color:var(--text3);font-weight:600;text-transform:uppercase;white-space:nowrap;`;

  const resumoCards = Object.entries(LABEL).filter(([k]) => totais[k] > 0).map(([cat, label]) =>
    `<div style="text-align:center;">
      <div style="font-size:.72rem;color:var(--text3);margin-bottom:.3rem;text-transform:uppercase;letter-spacing:.04em;">${label}s</div>
      <div style="font-size:1rem;font-weight:800;color:${COR[cat]};">${formatCurrency(totais[cat])}</div>
    </div>`
  ).join("");

  const excessoCard = totalExcesso > 0 ? `
    <div style="text-align:center;border-left:2px solid var(--red);padding-left:.75rem;">
      <div style="font-size:.72rem;color:var(--red);margin-bottom:.3rem;text-transform:uppercase;letter-spacing:.04em;">Retirado a mais</div>
      <div style="font-size:1rem;font-weight:800;color:var(--red);">${formatCurrency(totalExcesso)}</div>
      <div style="font-size:.7rem;color:var(--text3);">acima do dinheiro</div>
    </div>` : "";

  const rows = linhas.map(l => {
    const cor = COR[l.categoria] || "var(--text3)";
    const label = LABEL[l.categoria] || l.categoria;
    const bgRow = l.excesso ? "background:rgba(239,68,68,.05);" : "";

    let excessoCell = "";
    if (l.categoria === "retirada_final" && l.dinheiroCaixa !== null) {
      if (l.excesso) {
        excessoCell = `<span style="color:var(--red);font-weight:700;">+${formatCurrency(l.excesso)} a mais</span>
                       <div style="font-size:.72rem;color:var(--text3);">Caixa tinha ${formatCurrency(l.dinheiroCaixa)}</div>`;
      } else {
        excessoCell = `<span style="color:var(--green);font-size:.8rem;">OK</span>
                       <div style="font-size:.72rem;color:var(--text3);">Caixa: ${formatCurrency(l.dinheiroCaixa)}</div>`;
      }
    }

    return `<tr style="border-bottom:1px solid var(--border);${bgRow}">
      <td style="padding:.55rem .75rem;font-size:.84rem;">${escapeHTML(l.data)}</td>
      <td style="padding:.55rem .75rem;font-size:.84rem;">${l.turno === "manha" ? "Manhã" : "Tarde"}</td>
      <td style="padding:.55rem .75rem;font-size:.84rem;">${escapeHTML(l.operador || "—")}</td>
      <td style="padding:.55rem .75rem;font-size:.84rem;color:var(--text3);">${escapeHTML(l.hora)}</td>
      <td style="padding:.55rem .75rem;font-size:.84rem;">
        <span style="background:${cor}22;color:${cor};padding:.15rem .5rem;border-radius:4px;font-size:.75rem;font-weight:700;">${label}</span>
      </td>
      <td style="padding:.55rem .75rem;font-size:.84rem;">${escapeHTML(l.descricao)}</td>
      <td style="padding:.55rem .75rem;font-size:.84rem;text-align:right;font-weight:700;color:${cor};">${formatCurrency(l.valor)}</td>
      <td style="padding:.55rem .75rem;font-size:.84rem;text-align:right;">${excessoCell}</td>
    </tr>`;
  }).join("");

  cont.innerHTML = `
    <div class="card" style="margin-bottom:1rem;">
      <div class="card-header"><h2>Resumo do período</h2></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:.75rem;padding:.25rem 1rem 1rem;">
        ${resumoCards}
        <div style="text-align:center;border-left:1px solid var(--border);padding-left:.75rem;">
          <div style="font-size:.72rem;color:var(--text3);margin-bottom:.3rem;text-transform:uppercase;letter-spacing:.04em;">Total Geral</div>
          <div style="font-size:1rem;font-weight:800;color:var(--text);">${formatCurrency(totalGeral)}</div>
        </div>
        ${excessoCard}
      </div>
    </div>
    <div class="card">
      <div class="card-header"><h2>Detalhamento</h2></div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="border-bottom:2px solid var(--border);">
              <th style="text-align:left;${thStyle}">Data</th>
              <th style="text-align:left;${thStyle}">Turno</th>
              <th style="text-align:left;${thStyle}">Operador</th>
              <th style="text-align:left;${thStyle}">Hora</th>
              <th style="text-align:left;${thStyle}">Tipo</th>
              <th style="text-align:left;${thStyle}">Descrição</th>
              <th style="text-align:right;${thStyle}">Valor</th>
              <th style="text-align:right;${thStyle}">Vs. Caixa</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
}

function exportarHistorico() {
  const lista = getHistoricoFiltrado();
  if (!lista.length) return showToast("Nao ha dados para exportar.", "error");
  const header = "Data,Turno,Operador,Venda Sistema,Dinheiro,Cartoes/Pix,Total Entradas,Sangrias,Retiradas,Vales,Saldo Final,Saldo Proximo\n";
  const rows = lista.map(item => {
    const p = item.porPagamento || {};
    const cartoesPix = (p.pix || 0) + (p.debito || 0) + (p.credito || 0) + (p.maquininha || 0);
    return [item.data, item.turno, item.operador, item.vendaBruta || 0, p.dinheiro || 0, cartoesPix, item.entradas || 0, item.sangrias || 0, (item.retiradas || 0) + (item.retiradaFinal || 0), item.vales || 0, item.saldoFinal || 0, item.saldoProximo || 0].map(v => `"${String(v).replace(/"/g, '""')}"`).join(",");
  }).join("\n");
  const link = document.createElement("a");
  link.href = "data:text/csv;charset=utf-8," + encodeURIComponent(header + rows);
  link.download = `historico_caixa_${isoHoje()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function imprimirFechamento() {
  if (!caixa) return showToast("Nenhum caixa aberto.", "error");
  const t = calcularTotais();
  imprimirRelatorio({ data: dataBRFromISO(qs("data-fechamento")?.value || isoHoje()), turno: caixa.turno, operador: caixa.operador, saldoInicial: caixa.saldoInicial, ...t, listaSaidas: saidas, listaVales: vales, porPagamento: totaisEntradas, obs: qs("fech-obs")?.value || "", saldoProximo: num("fech-saldo-proximo") || null });
}

function imprimirHistorico(id) {
  const item = historico.find(h => h.id === id);
  if (item) imprimirRelatorio(item);
}

function imprimirRelatorio(data) {
  const p = migrarPagamentos(data.porPagamento || {});
  qs("print-content").innerHTML = `
    <div class="print-header"><div class="print-title">FECHAMENTO DE CAIXA</div><div class="print-sub">Data: ${escapeHTML(data.data)} - Turno: ${data.turno === "manha" ? "Manha" : "Tarde"} - Operador: ${escapeHTML(data.operador || "-")}</div></div>
    <hr class="print-divider" />
    <div class="print-row"><span>Saldo Inicial</span><span>${formatCurrency(data.saldoInicial || 0)}</span></div>
    <div class="print-row"><span>Total Entradas</span><span>${formatCurrency(data.entradas || 0)}</span></div>
    <div class="print-row"><span>Total Saidas</span><span>${formatCurrency(data.saidas || 0)}</span></div>
    <hr class="print-divider" />
    ${Object.entries(PAGAMENTOS).map(([key, label]) => `<div class="print-row"><span>${label}</span><span>${formatCurrency(p[key] || 0)}</span></div>`).join("")}
    <div class="print-row"><span>Vales funcionarios (nao recebimento)</span><span>${formatCurrency(data.vales || 0)}</span></div>
    <hr class="print-divider" />
    <div class="print-row print-total"><span>Saldo Final</span><span>${formatCurrency(data.saldoFinal || 0)}</span></div>
    ${data.saldoProximo != null ? `<div class="print-row"><span>Saldo p/ proximo caixa</span><span>${formatCurrency(data.saldoProximo)}</span></div>` : ""}
  `;
  qs("print-area").style.display = "block";
  window.print();
  qs("print-area").style.display = "none";
}

function imprimirRelatorioSangriasVales() {
  const lista = getHistoricoFiltrado();
  if (!lista.length) return showToast("Nenhum fechamento encontrado para o periodo.", "error");

  const inicio = qs("filtro-data-ini")?.value ? dataBRFromISO(qs("filtro-data-ini").value) : "Inicio";
  const fim = qs("filtro-data-fim")?.value ? dataBRFromISO(qs("filtro-data-fim").value) : "Hoje";
  const sangrias = [];
  const valesRelatorio = [];

  lista.forEach(fechamento => {
    (fechamento.listaSaidas || [])
      .filter(saida => saida.categoria === "sangria")
      .forEach(saida => sangrias.push({
        data: fechamento.data,
        turno: fechamento.turno,
        operador: fechamento.operador,
        descricao: saida.descricao || "Sangria",
        valor: saida.valor || 0
      }));

    (fechamento.listaVales || []).forEach(vale => valesRelatorio.push({
      data: fechamento.data,
      turno: fechamento.turno,
      operador: fechamento.operador,
      funcionario: vale.nome || "-",
      motivo: vale.obs || "-",
      valor: vale.valor || 0
    }));
  });

  const totalSangrias = sangrias.reduce((sum, item) => sum + item.valor, 0);
  const totalVales = valesRelatorio.reduce((sum, item) => sum + item.valor, 0);

  const sangriasRows = sangrias.length
    ? sangrias.map(item => `
      <tr>
        <td>${escapeHTML(item.data)}</td>
        <td>${item.turno === "manha" ? "Manha" : "Tarde"}</td>
        <td>${escapeHTML(item.operador || "-")}</td>
        <td>${escapeHTML(item.descricao)}</td>
        <td>${formatCurrency(item.valor)}</td>
      </tr>
    `).join("")
    : '<tr><td colspan="5">Nenhuma sangria no periodo</td></tr>';

  const valesRows = valesRelatorio.length
    ? valesRelatorio.map(item => `
      <tr>
        <td>${escapeHTML(item.data)}</td>
        <td>${item.turno === "manha" ? "Manha" : "Tarde"}</td>
        <td>${escapeHTML(item.operador || "-")}</td>
        <td>${escapeHTML(item.funcionario)}</td>
        <td>${escapeHTML(item.motivo)}</td>
        <td>${formatCurrency(item.valor)}</td>
      </tr>
    `).join("")
    : '<tr><td colspan="6">Nenhum vale no periodo</td></tr>';

  qs("print-content").innerHTML = `
    <div class="print-header">
      <div class="print-title">RELATORIO DE SANGRIAS E VALES</div>
      <div class="print-sub">Periodo: ${inicio} a ${fim}</div>
    </div>
    <hr class="print-divider" />
    <div class="print-section-title">RESUMO</div>
    <div class="print-row"><span>Total de sangrias</span><span>${formatCurrency(totalSangrias)}</span></div>
    <div class="print-row"><span>Total de vales funcionarios</span><span>${formatCurrency(totalVales)}</span></div>
    <div class="print-row print-total"><span>Total geral</span><span>${formatCurrency(totalSangrias + totalVales)}</span></div>
    <hr class="print-divider" />
    <div class="print-section-title">SANGRIAS</div>
    <table class="print-table">
      <thead><tr><th>Data</th><th>Turno</th><th>Operador</th><th>Descricao</th><th>Valor</th></tr></thead>
      <tbody>${sangriasRows}</tbody>
    </table>
    <hr class="print-divider" />
    <div class="print-section-title">VALES DE FUNCIONARIO</div>
    <table class="print-table">
      <thead><tr><th>Data</th><th>Turno</th><th>Operador</th><th>Funcionario</th><th>Motivo</th><th>Valor</th></tr></thead>
      <tbody>${valesRows}</tbody>
    </table>
  `;
  qs("print-area").style.display = "block";
  window.print();
  qs("print-area").style.display = "none";
}

function enviarWhatsApp(id) {
  const item = historico.find(h => h.id === id);
  if (!item) return;
  const p = migrarPagamentos(item.porPagamento || {});
  const listaSaidas = item.listaSaidas || [];
  const sangrias = listaSaidas.filter(saida => saida.categoria === "sangria");
  const retiradas = listaSaidas.filter(saida => saida.categoria === "retirada");
  let texto = `*${item.data}*\nCaixa ${item.turno === "manha" ? "Manha" : "Tarde"}\n${item.operador || ""}\n\n`;
  texto += `*Venda: ${formatCurrency(item.vendaBruta || 0)}*\n\n`;
  texto += `Dinheiro: ${formatCurrency(p.dinheiro || 0)}\nCredito: ${formatCurrency(p.credito || 0)}\nDebito: ${formatCurrency(p.debito || 0)}\nMaquininha: ${formatCurrency(p.maquininha || 0)}\nPIX: ${formatCurrency(p.pix || 0)}\n`;
 if (item.listaVales?.length) {
  texto += `\n*Vales funcionários*\n`;

  item.listaVales.forEach(vale => {
    texto += `${vale.nome || "-"} - ${formatCurrency(vale.valor || 0)} - ${vale.obs || "Vale"}\n`;
  });
}

  if (sangrias.length) {
    texto += `\n*Sangrias*\n`;
    sangrias.forEach(saida => {
      texto += `${formatCurrency(saida.valor)} - ${saida.descricao || "Sangria"}\n`;
    });
    texto += `Total sangrias: ${formatCurrency(item.sangrias || sangrias.reduce((sum, saida) => sum + saida.valor, 0))}\n`;
  }

  if (retiradas.length || item.retiradaFinal > 0) {
    texto += `\n*Retiradas*\n`;
    retiradas.forEach(saida => {
      texto += `${formatCurrency(saida.valor)} - ${saida.descricao || "Retirada"}\n`;
    });
    if (item.retiradaFinal > 0) texto += `${formatCurrency(item.retiradaFinal)} - Retirada final\n`;
  }

  texto += `\nTotal: ${formatCurrency(item.entradas || 0)}`;
  if (item.saldoProximo != null) texto += `\nProximo caixa: ${formatCurrency(item.saldoProximo)}`;
  window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(texto)}`, "_blank");
}

function showModal(id) {
  qs(id)?.classList.add("open");
}

function closeModal(id) {
  qs(id)?.classList.remove("open");
}

function showToast(message, type = "info") {
  const toast = qs("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast ${type} show`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("show"), 4000);
}

function toggleNotificacoes() {
  qs("notif-panel")?.classList.toggle("open");
}

function addNotificacao(msg, tipo = "info") {
  notificacoesGlobais.unshift({ id: Date.now(), msg, tipo, hora: new Date().toLocaleString("pt-BR") });
  notificacoesGlobais = notificacoesGlobais.slice(0, 50);
  localStorage.setItem("caixa_notificacoes", JSON.stringify(notificacoesGlobais));
  renderizarNotificacoes();
}

function limparNotificacoes() {
  notificacoesGlobais = [];
  localStorage.removeItem("caixa_notificacoes");
  renderizarNotificacoes();
  qs("notif-panel")?.classList.remove("open");
}

function renderizarNotificacoes() {
  const badge = qs("notif-badge");
  const list = qs("notif-list");
  if (!badge || !list) return;
  badge.style.display = notificacoesGlobais.length ? "flex" : "none";
  badge.textContent = notificacoesGlobais.length;
  list.innerHTML = notificacoesGlobais.length
    ? notificacoesGlobais.map(item => `<div class="notif-item ${item.tipo}"><span>${escapeHTML(item.msg)}</span><span class="notif-time">${escapeHTML(item.hora)}</span></div>`).join("")
    : '<div class="empty-state" style="padding:1.5rem"><p>Nenhuma notificacao</p></div>';
}

function iniciarAuth() {
  if (!auth) {
    mostrarErroLogin("Firebase Auth nao carregou. Verifique se o SDK firebase-auth-compat.js esta no HTML.");
    return;
  }

  auth.languageCode = "pt-BR";

  if (auth.isSignInWithEmailLink(window.location.href)) {
    let email = localStorage.getItem("emailLinkLogin");
    if (!email) {
      email = window.prompt("Confirme seu e-mail para concluir o login:");
    }
    if (email) {
      auth.signInWithEmailLink(email, window.location.href)
        .then(() => {
          localStorage.removeItem("emailLinkLogin");
          window.history.replaceState({}, document.title, window.location.pathname);
        })
        .catch(error => {
          console.error(error);
          mostrarErroLogin(getMensagemAuth(error));
        });
    }
  }

  auth.onAuthStateChanged(user => {
    const loginScreen = qs("login-screen");
    const usuario = qs("usuario-logado");
    if (user) {
      loginScreen?.classList.add("hidden");
      setText("usuario-logado", user.email || user.displayName || "Usuario logado");
    } else {
      loginScreen?.classList.remove("hidden");
      if (usuario) usuario.textContent = "";
    }
  });
}

async function fazerLogin() {
  if (!auth) return mostrarErroLogin("Firebase Auth nao esta disponivel.");
  const email = qs("login-email")?.value.trim();
  const senha = qs("login-password")?.value || "";
  if (!email || !senha) return mostrarErroLogin("Informe email e senha.");

  setLoginLoading(true);
  try {
    await auth.signInWithEmailAndPassword(email, senha);
    limparCamposLogin();
  } catch (error) {
    console.error(error);
    mostrarErroLogin(getMensagemAuth(error));
  } finally {
    setLoginLoading(false);
  }
}

async function criarContaEmail() {
  if (!auth) return mostrarErroLogin("Firebase Auth nao esta disponivel.");
  const email = qs("login-email")?.value.trim();
  const senha = qs("login-password")?.value || "";
  if (!email || !senha) return mostrarErroLogin("Informe email e senha para criar a conta.");
  if (senha.length < 6) return mostrarErroLogin("A senha precisa ter pelo menos 6 caracteres.");

  setLoginLoading(true);
  try {
    await auth.createUserWithEmailAndPassword(email, senha);
    limparCamposLogin();
    showToast("Conta criada e login realizado.", "success");
  } catch (error) {
    console.error(error);
    mostrarErroLogin(getMensagemAuth(error));
  } finally {
    setLoginLoading(false);
  }
}

async function loginGoogle() {
  if (!auth) return mostrarErroLogin("Firebase Auth nao esta disponivel.");
  setLoginLoading(true);
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    await auth.signInWithPopup(provider);
    limparCamposLogin();
  } catch (error) {
    console.error(error);
    mostrarErroLogin(getMensagemAuth(error));
  } finally {
    setLoginLoading(false);
  }
}

async function enviarLinkLogin() {
  if (!auth) return mostrarErroLogin("Firebase Auth nao esta disponivel.");
  const email = qs("login-email")?.value.trim();
  if (!email) return mostrarErroLogin("Informe seu e-mail para receber o link.");

  const btn = qs("btn-link-login");
  if (btn) { btn.disabled = true; btn.textContent = "Enviando..."; }
  try {
    const actionCodeSettings = {
      url: window.location.origin + window.location.pathname,
      handleCodeInApp: true
    };
    await auth.sendSignInLinkToEmail(email, actionCodeSettings);
    localStorage.setItem("emailLinkLogin", email);
    mostrarInfoLogin(`Link enviado para ${email}. Verifique sua caixa de entrada e clique no link para entrar.`);
  } catch (error) {
    console.error(error);
    mostrarErroLogin(getMensagemAuth(error));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Entrar sem senha"; }
  }
}

async function sair() {
  if (!auth) return;
  try {
    await auth.signOut();
    showToast("Voce saiu do sistema.", "info");
  } catch (error) {
    console.error(error);
    showToast("Nao foi possivel sair.", "error");
  }
}

function limparCamposLogin() {
  setValue("login-email", "");
  setValue("login-password", "");
}

function setLoginLoading(loading) {
  const btn = qs("btn-login");
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? "Aguarde..." : "Entrar";
}

function mostrarErroLogin(message) {
  const error = qs("login-error");
  if (!error) return;
  error.textContent = message;
  error.style.display = "block";
  setTimeout(() => error.style.display = "none", 5000);
}

function mostrarInfoLogin(message) {
  const info = qs("login-info");
  if (!info) return;
  info.textContent = message;
  info.style.display = "block";
}

function getMensagemAuth(error) {
  const code = error?.code || "";
  const mensagens = {
    "auth/configuration-not-found": "Firebase Authentication ainda nao esta configurado. Ative Authentication no Firebase Console.",
    "auth/invalid-email": "Email invalido.",
    "auth/user-disabled": "Este usuario esta desativado.",
    "auth/user-not-found": "Usuario nao encontrado.",
    "auth/wrong-password": "Senha incorreta.",
    "auth/invalid-credential": "Email ou senha incorretos.",
    "auth/email-already-in-use": "Este email ja esta cadastrado.",
    "auth/weak-password": "A senha precisa ter pelo menos 6 caracteres.",
    "auth/popup-closed-by-user": "Login cancelado antes de concluir.",
    "auth/popup-blocked": "O navegador bloqueou a janela do Google. Libere pop-ups para este site.",
    "auth/cancelled-popup-request": "Ja existe uma janela de login aberta. Feche ela e tente novamente.",
    "auth/operation-not-allowed": "Metodo de login nao habilitado no Firebase. Ative Google e/ou Email/Senha em Authentication > Sign-in method.",
    "auth/unauthorized-domain": `Dominio nao autorizado no Firebase Auth. Adicione "${window.location.hostname || "este dominio"}" em Authentication > Settings > Authorized domains.`,
    "auth/network-request-failed": "Falha de rede ao conectar no Firebase. Verifique sua internet.",
    "auth/too-many-requests": "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
    "auth/admin-restricted-operation": "Cadastro bloqueado no Firebase. Crie o usuario pelo console ou libere Email/Senha.",
    "auth/invalid-action-code": "O link de login e invalido ou ja foi usado. Solicite um novo link.",
    "auth/expired-action-code": "O link de login expirou. Solicite um novo link."
  };
  return mensagens[code] || `Nao foi possivel autenticar (${code || "erro sem codigo"}). Verifique o Firebase Authentication.`;
}

document.addEventListener("click", event => {
  const panel = qs("notif-panel");
  const button = qs("btn-notificacoes");
  if (panel?.classList.contains("open") && button && !panel.contains(event.target) && !button.contains(event.target)) {
    panel.classList.remove("open");
  }
});

// ══════════════════════════════════════════
// EXPORTAÇÃO DE PLANILHA
// ══════════════════════════════════════════

const EXPORT_COLUNAS = [
  { key: "data",          label: "Data",            getValue: i => i.data || "" },
  { key: "turno",         label: "Turno",           getValue: i => i.turno === "manha" ? "Manhã" : "Tarde" },
  { key: "operador",      label: "Operador",        getValue: i => i.operador || "" },
  { key: "vendaBruta",    label: "Venda Sistema",   getValue: i => i.vendaBruta || 0 },
  { key: "dinheiro",      label: "Dinheiro",        getValue: i => (i.porPagamento?.dinheiro) || 0 },
  { key: "credito",       label: "Crédito",         getValue: i => (i.porPagamento?.credito) || 0 },
  { key: "debito",        label: "Débito",          getValue: i => (i.porPagamento?.debito) || 0 },
  { key: "maquininha",    label: "Maquininha",      getValue: i => (i.porPagamento?.maquininha) || 0 },
  { key: "pix",           label: "PIX",             getValue: i => (i.porPagamento?.pix) || 0 },
  { key: "entradas",      label: "Total Entradas",  getValue: i => i.entradas || 0 },
  { key: "sangrias",      label: "Sangrias",        getValue: i => i.sangrias || 0 },
  { key: "retiradas",     label: "Retiradas",       getValue: i => i.retiradas || 0 },
  { key: "vales",         label: "Vales",           getValue: i => i.vales || 0 },
  { key: "saidas",        label: "Total Saídas",    getValue: i => i.saidas || 0 },
  { key: "saldoFinal",    label: "Saldo Final",     getValue: i => i.saldoFinal || 0 },
  { key: "retiradaFinal", label: "Retirada Final",  getValue: i => i.retiradaFinal || 0 },
  { key: "saldoProximo",  label: "Saldo Próximo",   getValue: i => i.saldoProximo ?? "" },
  { key: "obs",           label: "Observações",     getValue: i => i.obs || "" },
];

function showModalExport() {
  const lista = getHistoricoFiltrado();
  const infoEl = qs("export-info");
  if (infoEl) {
    const ini = qs("filtro-data-ini")?.value;
    const fim = qs("filtro-data-fim")?.value;
    const filtroAtivo = ini || fim;
    infoEl.textContent = `${lista.length} fechamento(s)${filtroAtivo ? " no período filtrado" : " no histórico total"}`;
  }

  const grid = qs("export-cols-grid");
  if (grid) {
    grid.innerHTML = EXPORT_COLUNAS.map(col => `
      <label class="export-col-item">
        <input type="checkbox" value="${col.key}" checked />
        <span>${col.label}</span>
      </label>
    `).join("");
  }

  // Reset format para xlsx
  const radioXlsx = document.querySelector('input[name="export-fmt"][value="xlsx"]');
  if (radioXlsx) radioXlsx.checked = true;
  atualizarFormatoExport("xlsx");

  showModal("modal-exportar");
}

function selecionarTodasColunas(checked) {
  document.querySelectorAll("#export-cols-grid input[type=checkbox]").forEach(el => {
    el.checked = checked;
  });
}

function atualizarFormatoExport(fmt) {
  const extrasSection = qs("export-extras-section");
  const extraInputs = document.querySelectorAll(".export-extras input");
  if (fmt === "csv") {
    extrasSection?.classList.add("disabled");
    // Usa classe no elemento filho
    document.querySelector(".export-extras")?.classList.add("disabled");
    extraInputs.forEach(el => el.disabled = true);
  } else {
    document.querySelector(".export-extras")?.classList.remove("disabled");
    extraInputs.forEach(el => el.disabled = false);
  }
}

function confirmarExportacao() {
  const lista = getHistoricoFiltrado();
  if (!lista.length) return showToast("Nenhum dado para exportar.", "error");

  const formato = document.querySelector('input[name="export-fmt"]:checked')?.value || "xlsx";
  const selecionadas = [...document.querySelectorAll("#export-cols-grid input[type=checkbox]:checked")].map(el => el.value);

  if (!selecionadas.length) return showToast("Selecione ao menos uma coluna.", "error");

  const colunas = EXPORT_COLUNAS.filter(c => selecionadas.includes(c.key));
  const header = colunas.map(c => c.label);
  const rows = lista.map(item => colunas.map(c => c.getValue(item)));
  const mainRows = [header, ...rows];

  if (formato === "xlsx") {
    const incSangrias = qs("export-inc-sangrias")?.checked;
    const incVales = qs("export-inc-vales")?.checked;
    exportXLSX(
      mainRows,
      incSangrias ? buildSangriasRows(lista) : null,
      incVales ? buildValesRows(lista) : null
    );
  } else {
    exportCSVRows(mainRows);
  }

  closeModal("modal-exportar");
}

function exportXLSX(mainRows, sangriasRows, valesRows) {
  if (typeof XLSX === "undefined") {
    showToast("Biblioteca Excel não carregada. Verifique a conexão e recarregue.", "error");
    return;
  }

  const wb = XLSX.utils.book_new();

  // ── Aba Fechamentos ──
  const ws = XLSX.utils.aoa_to_sheet(mainRows);
  // Largura automática das colunas
  ws["!cols"] = mainRows[0].map((h, i) => {
    const maxLen = Math.max(
      String(h).length,
      ...mainRows.slice(1).map(row => String(row[i] ?? "").length)
    );
    return { wch: Math.min(Math.max(maxLen + 2, 12), 40) };
  });
  // Formato numérico nas células de valor (linhas 2+)
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
  for (let R = 1; R <= range.e.r; R++) {
    for (let C = 0; C <= range.e.c; C++) {
      const ref = XLSX.utils.encode_cell({ r: R, c: C });
      if (ws[ref] && typeof ws[ref].v === "number") {
        ws[ref].t = "n";
        ws[ref].z = '#,##0.00';
      }
    }
  }
  XLSX.utils.book_append_sheet(wb, ws, "Fechamentos");

  // ── Aba Sangrias ──
  if (sangriasRows?.length > 1) {
    const ws2 = XLSX.utils.aoa_to_sheet(sangriasRows);
    ws2["!cols"] = sangriasRows[0].map(h => ({ wch: Math.max(String(h).length + 2, 14) }));
    XLSX.utils.book_append_sheet(wb, ws2, "Sangrias");
  } else if (sangriasRows) {
    const ws2 = XLSX.utils.aoa_to_sheet([sangriasRows[0], ["Nenhuma sangria no período"]]);
    XLSX.utils.book_append_sheet(wb, ws2, "Sangrias");
  }

  // ── Aba Vales ──
  if (valesRows?.length > 1) {
    const ws3 = XLSX.utils.aoa_to_sheet(valesRows);
    ws3["!cols"] = valesRows[0].map(h => ({ wch: Math.max(String(h).length + 2, 14) }));
    XLSX.utils.book_append_sheet(wb, ws3, "Vales");
  } else if (valesRows) {
    const ws3 = XLSX.utils.aoa_to_sheet([valesRows[0], ["Nenhum vale no período"]]);
    XLSX.utils.book_append_sheet(wb, ws3, "Vales");
  }

  XLSX.writeFile(wb, `vortek_caixa_${isoHoje()}.xlsx`);
  showToast("Planilha Excel exportada!", "success");
}

function exportCSVRows(rows) {
  const content = rows.map(row =>
    row.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")
  ).join("\n");
  // BOM para abrir corretamente no Excel com acentos
  const link = document.createElement("a");
  link.href = "data:text/csv;charset=utf-8,﻿" + encodeURIComponent(content);
  link.download = `vortek_caixa_${isoHoje()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  showToast("CSV exportado!", "success");
}

function buildSangriasRows(lista) {
  const header = ["Data", "Turno", "Operador", "Descrição", "Valor"];
  const rows = [];
  lista.forEach(fech => {
    (fech.listaSaidas || [])
      .filter(s => s.categoria === "sangria")
      .forEach(s => rows.push([
        fech.data || "",
        fech.turno === "manha" ? "Manhã" : "Tarde",
        fech.operador || "",
        s.descricao || "Sangria",
        s.valor || 0
      ]));
  });
  return [header, ...rows];
}

function buildValesRows(lista) {
  const header = ["Data", "Turno", "Operador", "Funcionário", "Motivo", "Valor"];
  const rows = [];
  lista.forEach(fech => {
    (fech.listaVales || []).forEach(v => rows.push([
      fech.data || "",
      fech.turno === "manha" ? "Manhã" : "Tarde",
      fech.operador || "",
      v.nome || "",
      v.obs || "",
      v.valor || 0
    ]));
  });
  return [header, ...rows];
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
