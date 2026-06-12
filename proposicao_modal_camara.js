/*
 * proposicao_modal_camara.js
 * Modal offline/online para enriquecer proposições com a API RESTful
 * de Dados Abertos da Câmara dos Deputados.
 *
 * Uso básico no relatorio.html:
 *   <script src="static/proposicao_modal_camara.js"></script>
 *   <script>
 *     window.CamaraProposicaoModal.init({ selector: '[data-proposicao-id], a.external-link' });
 *   </script>
 *
 * O script intercepta cliques em:
 *   - elementos com data-proposicao-id="123";
 *   - links cujo href contenha idProposicao=123.
 */
(function(){
  'use strict';

  const API_BASE = 'https://dadosabertos.camara.leg.br/api/v2';
  const DEFAULT_SELECTOR = '[data-proposicao-id], a[href*="idProposicao="], a.external-link';

  const state = {
    cache: new Map(),
    initialized: false,
    options: {
      selector: DEFAULT_SELECTOR,
      interceptLinks: true,
      maxPropPrincipalDepth: 12,
      maxConcurrentVotacoes: 4,
      timeoutMs: 45000
    }
  };

  function $(id){ return document.getElementById(id); }

  function safe(v, fb=''){
    return (v === null || v === undefined || v === '') ? fb : String(v);
  }

  function escapeHtml(v){
    return safe(v).replace(/[&<>"']/g, function(c){
      return {
        '&':'&amp;',
        '<':'&lt;',
        '>':'&gt;',
        '"':'&quot;',
        "'":'&#39;'
      }[c];
    });
  }

  function onlyDate(s){ return safe(s).slice(0, 10); }

  function fmtDate(s){
    const d = onlyDate(s);
    if(!d) return 's/d';
    const parts = d.split('-');
    if(parts.length !== 3) return 's/d';
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }

  function normalizeApiUrl(endpointOrUrl){
    if(!endpointOrUrl) return '';
    if(/^https?:\/\//i.test(endpointOrUrl)) return endpointOrUrl;
    if(endpointOrUrl.charAt(0) !== '/') endpointOrUrl = '/' + endpointOrUrl;
    return API_BASE + endpointOrUrl;
  }

  function getIdFromUri(uri){
    const m = safe(uri).match(/\/(\d+)(?:\?.*)?$/);
    return m ? Number(m[1]) : null;
  }

  function getIdFromHref(href){
    if(!href) return null;
    try{
      const url = new URL(href, window.location.href);
      const id = url.searchParams.get('idProposicao') || url.searchParams.get('id');
      return id ? Number(id) : null;
    }catch(e){
      const m = String(href).match(/[?&](?:idProposicao|id)=(\d+)/);
      return m ? Number(m[1]) : null;
    }
  }

  function getIdFromElement(el){
    if(!el) return null;
    const direct = el.getAttribute('data-proposicao-id');
    if(direct) return Number(direct);
    const href = el.getAttribute('href');
    return getIdFromHref(href);
  }

  function cacheKey(url){ return url; }

  async function fetchJson(endpointOrUrl, options){
    const url = normalizeApiUrl(endpointOrUrl);
    const key = cacheKey(url);
    if(state.cache.has(key)) return state.cache.get(key);

    const controller = new AbortController();
    const timeout = setTimeout(function(){ controller.abort(); }, state.options.timeoutMs);

    try{
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
        cache: 'default',
        ...(options || {})
      });

      if(!res.ok){
        throw new Error(`HTTP ${res.status} em ${url}`);
      }

      const json = await res.json();
      state.cache.set(key, json);
      return json;
    }finally{
      clearTimeout(timeout);
    }
  }

  function findNextLink(payload){
    const links = (payload && payload.links) || [];
    const next = links.find(function(l){ return l.rel === 'next'; });
    return next ? next.href : null;
  }

  async function fetchAllPages(endpointOrUrl){
    let url = normalizeApiUrl(endpointOrUrl);
    let out = [];

    while(url){
      const payload = await fetchJson(url);
      const dados = payload.dados;
      if(Array.isArray(dados)) out = out.concat(dados);
      else if(dados) out.push(dados);
      url = findNextLink(payload);
    }

    return out;
  }

  async function fetchDados(endpointOrUrl){
    const payload = await fetchJson(endpointOrUrl);
    return payload && payload.dados !== undefined ? payload.dados : payload;
  }

  function endpointProposicao(id, suffix){
    return `/proposicoes/${encodeURIComponent(id)}${suffix || ''}`;
  }

  async function resolverProposicaoPrincipal(idInicial){
    const cadeia = [];
    const visitados = new Set();
    let atualId = Number(idInicial);
    let atualDetalhes = null;

    for(let depth = 0; depth < state.options.maxPropPrincipalDepth; depth++){
      if(!atualId || visitados.has(atualId)) break;
      visitados.add(atualId);

      atualDetalhes = await fetchDados(endpointProposicao(atualId));
      cadeia.push(atualDetalhes);

      const uriPrincipal = atualDetalhes && atualDetalhes.uriPropPrincipal;
      if(!uriPrincipal) break;

      const proxId = getIdFromUri(uriPrincipal);
      if(!proxId || proxId === atualId) break;
      atualId = proxId;
    }

    const principal = cadeia[cadeia.length - 1] || atualDetalhes;

    return {
      inicialId: Number(idInicial),
      principalId: principal ? Number(principal.id) : Number(idInicial),
      cadeia: cadeia,
      detalhesPrincipal: principal
    };
  }

  async function fetchVotacaoCompleta(votacao){
    const id = votacao && votacao.id;
    if(!id) return { resumo: votacao, detalhes: null, orientacoes: [], votos: [], erro: 'Votação sem id.' };

    try{
      const [detalhesPayload, orientacoes, votos] = await Promise.all([
        fetchJson(`/votacoes/${encodeURIComponent(id)}`).catch(function(e){ return { erro: String(e), dados: null }; }),
        fetchAllPages(`/votacoes/${encodeURIComponent(id)}/orientacoes`).catch(function(){ return []; }),
        fetchAllPages(`/votacoes/${encodeURIComponent(id)}/votos`).catch(function(){ return []; })
      ]);

      return {
        resumo: votacao,
        detalhes: detalhesPayload && detalhesPayload.dados ? detalhesPayload.dados : detalhesPayload,
        orientacoes: orientacoes,
        votos: votos,
        erro: null
      };
    }catch(e){
      return { resumo: votacao, detalhes: null, orientacoes: [], votos: [], erro: String(e) };
    }
  }

  async function mapLimit(items, limit, mapper){
    const results = new Array(items.length);
    let index = 0;

    async function worker(){
      while(index < items.length){
        const current = index++;
        results[current] = await mapper(items[current], current);
      }
    }

    const workers = [];
    const count = Math.max(1, Math.min(limit, items.length));
    for(let i = 0; i < count; i++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  async function carregarPipelineProposicao(idInicial){
    const resolucao = await resolverProposicaoPrincipal(idInicial);
    const id = resolucao.principalId || idInicial;

    const [autores, temas, tramitacoes, relacionadas, votacoes] = await Promise.all([
      fetchAllPages(endpointProposicao(id, '/autores')).catch(function(){ return []; }),
      fetchAllPages(endpointProposicao(id, '/temas')).catch(function(){ return []; }),
      fetchAllPages(endpointProposicao(id, '/tramitacoes')).catch(function(){ return []; }),
      fetchAllPages(endpointProposicao(id, '/relacionadas')).catch(function(){ return []; }),
      fetchAllPages(endpointProposicao(id, '/votacoes')).catch(function(){ return []; })
    ]);

    const votacoesCompletas = votacoes.length
      ? await mapLimit(votacoes, state.options.maxConcurrentVotacoes, fetchVotacaoCompleta)
      : [];

    return {
      idInicial: Number(idInicial),
      idPrincipal: Number(id),
      detalhesInicial: resolucao.cadeia[0] || null,
      detalhesPrincipal: resolucao.detalhesPrincipal || null,
      cadeiaPrincipal: resolucao.cadeia,
      autores: autores,
      temas: temas,
      tramitacoes: tramitacoes,
      relacionadas: relacionadas,
      votacoes: votacoes,
      votacoesCompletas: votacoesCompletas,
      coletadoEm: new Date().toISOString()
    };
  }

  function ensureStyles(){
    if(document.getElementById('camara-prop-modal-style')) return;

    const style = document.createElement('style');
    style.id = 'camara-prop-modal-style';
    style.textContent = `
      .cpm-backdrop{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.58);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);display:none;}
      .cpm-backdrop.open{display:block;}
      .cpm-modal{position:fixed;inset:calc(14px + env(safe-area-inset-top)) 10px calc(14px + env(safe-area-inset-bottom));z-index:9001;display:none;flex-direction:column;border:1px solid rgba(0,229,255,.28);border-radius:24px;background:rgba(10,13,20,.92);box-shadow:0 0 0 1px rgba(0,229,255,.12),0 18px 60px rgba(0,0,0,.55),0 0 34px rgba(0,229,255,.16);overflow:hidden;color:#EAF7FF;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;}
      .cpm-modal.open{display:flex;}
      .cpm-head{display:flex;align-items:center;gap:10px;justify-content:space-between;padding:14px;border-bottom:1px solid rgba(255,255,255,.10);background:linear-gradient(135deg,rgba(0,229,255,.16),rgba(124,61,255,.14));}
      .cpm-title{font-size:16px;font-weight:800;line-height:1.2;letter-spacing:-.02em;min-width:0;}
      .cpm-sub{font-size:11px;color:#8FA8C2;font-family:'SF Mono',ui-monospace,monospace;margin-top:3px;}
      .cpm-close{appearance:none;border:1px solid rgba(0,229,255,.28);background:rgba(0,229,255,.10);color:#EAF7FF;border-radius:999px;width:44px;height:44px;font-size:22px;line-height:1;flex:0 0 44px;}
      .cpm-body{overflow:auto;padding:12px;display:grid;gap:10px;}
      .cpm-card{border:1px solid rgba(255,255,255,.10);border-radius:18px;background:rgba(255,255,255,.045);padding:12px;}
      .cpm-card h3{margin:0 0 8px;font-size:13px;color:#00E5FF;text-transform:uppercase;letter-spacing:.06em;font-family:'SF Mono',ui-monospace,monospace;}
      .cpm-text{font-size:13px;line-height:1.48;color:#D5E7F7;}
      .cpm-meta{font-size:11px;color:#8FA8C2;font-family:'SF Mono',ui-monospace,monospace;line-height:1.5;}
      .cpm-pillrow{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;}
      .cpm-pill{font-size:10.5px;border-radius:999px;border:1px solid rgba(0,229,255,.22);background:rgba(0,229,255,.08);padding:5px 8px;color:#BDF8FF;font-family:'SF Mono',ui-monospace,monospace;}
      .cpm-list{display:grid;gap:8px;}
      .cpm-item{border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:9px;background:rgba(0,0,0,.16);}
      .cpm-item-title{font-weight:800;font-size:13px;line-height:1.35;}
      .cpm-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;}
      .cpm-link{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:0 10px;border-radius:999px;border:1px solid rgba(0,229,255,.25);background:rgba(0,229,255,.08);color:#00E5FF;text-decoration:none;font-size:12px;font-weight:700;}
      .cpm-loading{padding:24px;text-align:center;color:#BDF8FF;font-size:13px;}
      .cpm-error{padding:14px;border-radius:18px;background:rgba(255,43,214,.10);border:1px solid rgba(255,43,214,.35);color:#FFD7F8;}
      .cpm-raw{white-space:pre-wrap;max-height:42vh;overflow:auto;font-family:'SF Mono',ui-monospace,monospace;font-size:10.5px;color:#BFD5E7;background:rgba(0,0,0,.22);border-radius:14px;padding:10px;}
    `;

    document.head.appendChild(style);
  }

  function ensureModal(){
    ensureStyles();
    if($('camaraPropModal')) return;

    const backdrop = document.createElement('div');
    backdrop.className = 'cpm-backdrop';
    backdrop.id = 'camaraPropModalBackdrop';

    const modal = document.createElement('section');
    modal.className = 'cpm-modal';
    modal.id = 'camaraPropModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <header class="cpm-head">
        <div style="min-width:0">
          <div class="cpm-title" id="camaraPropModalTitle">Proposição</div>
          <div class="cpm-sub" id="camaraPropModalSub">Dados Abertos da Câmara</div>
        </div>
        <button type="button" class="cpm-close" id="camaraPropModalClose" aria-label="Fechar">×</button>
      </header>
      <main class="cpm-body" id="camaraPropModalBody"></main>
    `;

    document.body.appendChild(backdrop);
    document.body.appendChild(modal);

    $('camaraPropModalClose').addEventListener('click', closeModal);
    backdrop.addEventListener('click', closeModal);
  }

  function openModal(){
    ensureModal();
    $('camaraPropModalBackdrop').classList.add('open');
    $('camaraPropModal').classList.add('open');
  }

  function closeModal(){
    const b = $('camaraPropModalBackdrop');
    const m = $('camaraPropModal');
    if(b) b.classList.remove('open');
    if(m) m.classList.remove('open');
  }

  function setModalLoading(id){
    $('camaraPropModalTitle').textContent = `Proposição ${id}`;
    $('camaraPropModalSub').textContent = 'Coletando detalhes, autores, temas, tramitações, relacionadas e votações…';
    $('camaraPropModalBody').innerHTML = '<div class="cpm-loading">⏳ Carregando dados da proposição…</div>';
  }

  function fichaUrl(id){
    return `https://www.camara.leg.br/proposicoesWeb/prop_imp?idProposicao=${encodeURIComponent(id)}&ord=1&tp=completa`;
  }

  function renderListaBasica(arr, titleFn, metaFn, textFn, limit){
    if(!arr || !arr.length) return '<div class="cpm-meta">Nenhum registro encontrado.</div>';
    const max = limit || 12;
    const html = arr.slice(0, max).map(function(x){
      return `
        <div class="cpm-item">
          <div class="cpm-item-title">${escapeHtml(titleFn(x))}</div>
          <div class="cpm-meta">${escapeHtml(metaFn ? metaFn(x) : '')}</div>
          <div class="cpm-text">${escapeHtml(textFn ? textFn(x) : '')}</div>
        </div>
      `;
    }).join('');
    return html + (arr.length > max ? `<div class="cpm-meta">Exibindo ${max} de ${arr.length} registros.</div>` : '');
  }

  function renderModalData(data){
    const p = data.detalhesPrincipal || {};
    const inicial = data.detalhesInicial || {};
    const ementa = p.ementa || p.ementaDetalhada || inicial.ementa || '';
    const titulo = `${safe(p.siglaTipo || inicial.siglaTipo)} ${safe(p.numero || inicial.numero)}/${safe(p.ano || inicial.ano)}`;

    $('camaraPropModalTitle').textContent = titulo;
    $('camaraPropModalSub').textContent = `ID principal ${safe(data.idPrincipal)} · ID clicado ${safe(data.idInicial)}`;

    const cadeiaHtml = (data.cadeiaPrincipal || []).map(function(x, i){
      return `<span class="cpm-pill">${i + 1}. ${escapeHtml(x.siglaTipo)} ${escapeHtml(x.numero)}/${escapeHtml(x.ano)} · ID ${escapeHtml(x.id)}</span>`;
    }).join('');

    const votacoesResumo = (data.votacoesCompletas || []).map(function(v){
      const d = v.detalhes || v.resumo || {};
      return `
        <div class="cpm-item">
          <div class="cpm-item-title">${escapeHtml(d.descricao || d.objeto || v.resumo?.descricao || 'Votação')}</div>
          <div class="cpm-meta">
            ID ${escapeHtml(v.resumo?.id || d.id)} · ${fmtDate(d.data || d.dataHoraRegistro || v.resumo?.data)} ·
            Orientações: ${escapeHtml((v.orientacoes || []).length)} ·
            Votos: ${escapeHtml((v.votos || []).length)}
          </div>
          <div class="cpm-text">${escapeHtml(d.descricaoResultado || d.aprovacao || '')}</div>
        </div>
      `;
    }).join('');

    $('camaraPropModalBody').innerHTML = `
      <section class="cpm-card">
        <h3>Detalhes</h3>
        <div class="cpm-text">${escapeHtml(ementa)}</div>
        <div class="cpm-pillrow">
          <span class="cpm-pill">ID ${escapeHtml(p.id || data.idPrincipal)}</span>
          <span class="cpm-pill">${escapeHtml(p.siglaTipo || '')}</span>
          <span class="cpm-pill">${escapeHtml(p.statusProposicao?.descricaoSituacao || p.statusProposicao?.regime || '')}</span>
        </div>
        <div class="cpm-actions">
          <a class="cpm-link" href="${fichaUrl(data.idPrincipal)}" target="_blank" rel="noopener noreferrer">Abrir ficha completa ↗</a>
          ${p.urlInteiroTeor ? `<a class="cpm-link" href="${escapeHtml(p.urlInteiroTeor)}" target="_blank" rel="noopener noreferrer">Inteiro teor ↗</a>` : ''}
        </div>
      </section>

      <section class="cpm-card">
        <h3>Proposição principal</h3>
        <div class="cpm-meta">Fluxo uriPropPrincipal até a proposição raiz:</div>
        <div class="cpm-pillrow">${cadeiaHtml || '<span class="cpm-pill">sem cadeia principal</span>'}</div>
      </section>

      <section class="cpm-card">
        <h3>Autores (${escapeHtml(data.autores.length)})</h3>
        <div class="cpm-list">
          ${renderListaBasica(data.autores, function(x){ return x.nome || x.nomeAutor || x.uri; }, function(x){ return x.tipo || x.tipoAutor || ''; }, function(x){ return x.siglaPartido ? `${x.siglaPartido}/${x.siglaUf || ''}` : ''; }, 10)}
        </div>
      </section>

      <section class="cpm-card">
        <h3>Temas (${escapeHtml(data.temas.length)})</h3>
        <div class="cpm-pillrow">
          ${data.temas.length ? data.temas.map(function(x){ return `<span class="cpm-pill">${escapeHtml(x.tema || x.descricao || JSON.stringify(x))}</span>`; }).join('') : '<span class="cpm-pill">sem temas</span>'}
        </div>
      </section>

      <section class="cpm-card">
        <h3>Tramitações (${escapeHtml(data.tramitacoes.length)})</h3>
        <div class="cpm-list">
          ${renderListaBasica(data.tramitacoes, function(x){ return x.descricaoTramitacao || x.descricaoSituacao || x.regime || 'Tramitação'; }, function(x){ return `${fmtDate(x.dataHora || x.data)} · ${x.siglaOrgao || ''}`; }, function(x){ return x.despacho || x.descricao || ''; }, 12)}
        </div>
      </section>

      <section class="cpm-card">
        <h3>Relacionadas (${escapeHtml(data.relacionadas.length)})</h3>
        <div class="cpm-list">
          ${renderListaBasica(data.relacionadas, function(x){ return `${x.siglaTipo || ''} ${x.numero || ''}/${x.ano || ''}`; }, function(x){ return `ID ${x.id || ''}`; }, function(x){ return x.ementa || ''; }, 10)}
        </div>
      </section>

      <section class="cpm-card">
        <h3>Votações (${escapeHtml(data.votacoesCompletas.length)})</h3>
        <div class="cpm-list">
          ${votacoesResumo || '<div class="cpm-meta">Nenhuma votação encontrada.</div>'}
        </div>
      </section>

      <section class="cpm-card">
        <h3>JSON coletado</h3>
        <div class="cpm-raw">${escapeHtml(JSON.stringify(data, null, 2))}</div>
      </section>
    `;
  }

  async function abrirProposicao(id){
    if(!id || !Number.isFinite(Number(id))){
      alert('ID da proposição inválido.');
      return;
    }

    openModal();
    setModalLoading(id);

    try{
      const data = await carregarPipelineProposicao(Number(id));
      renderModalData(data);
    }catch(e){
      $('camaraPropModalBody').innerHTML = `
        <div class="cpm-error">
          Falha ao carregar proposição.<br><br>
          ${escapeHtml(e && e.message ? e.message : String(e))}
        </div>
      `;
    }
  }

  function bindClicks(){
    document.addEventListener('click', function(ev){
      const el = ev.target.closest(state.options.selector || DEFAULT_SELECTOR);
      if(!el) return;

      const id = getIdFromElement(el);
      if(!id) return;

      if(state.options.interceptLinks){
        ev.preventDefault();
        ev.stopPropagation();
        abrirProposicao(id);
      }
    }, true);
  }

  function enhanceExistingCards(){
    document.querySelectorAll('a[href*="idProposicao="]').forEach(function(a){
      const id = getIdFromHref(a.getAttribute('href'));
      if(id) a.setAttribute('data-proposicao-id', String(id));
    });
  }

  function init(options){
    state.options = Object.assign({}, state.options, options || {});
    ensureModal();
    enhanceExistingCards();

    if(!state.initialized){
      bindClicks();
      state.initialized = true;
    }
  }

  window.CamaraProposicaoModal = {
    init: init,
    open: abrirProposicao,
    fetch: carregarPipelineProposicao,
    close: closeModal,
    cache: state.cache
  };
})();
