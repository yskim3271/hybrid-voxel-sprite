// site.js — instant KO / EN toggle (no reload), install tabs, copy buttons + toast.
// English lives in index.html; the English originals are captured from the DOM at start-up, so KO is the only
// dictionary that has to be maintained here. `?lang=ko|en` wins, then a saved choice, then the browser locale.
(function () {
  'use strict';

  var KO = {
    'nav.demo': '라이브 데모', 'nav.features': '특징', 'nav.engines': '엔진', 'nav.install': '설치', 'nav.docs': '문서',
    'hero.badge': '오픈 소스 · MIT 라이선스 · v1.1',
    'hero.title': '틈새 없이 움직이는<br><span class="accent">실시간 3D 복셀 스프라이트</span>',
    'hero.lede': '관절형 복셀 파츠 하나하나를 자기만의 회전 박스 안에서 레이마칭하는 에이전트 스킬입니다. ' +
      '<code>T3 OBB Raymarching</code> + <code>Inverse Deform</code> + <code>SVOX CLI</code> + <code>4 Engine Adapters</code>. ' +
      '스프라이트 스태킹의 감성에 실제 3D 볼륨을 더해, 픽셀 격자에 스냅하고 1&nbsp;px 외곽선을 두르며, 어떤 각도에서도 슬라이스 틈이 생기지 않습니다.',
    'hero.cta1': '시작하기', 'hero.cta2': 'GitHub에서 보기',
    'veh.excavator': '굴착기', 'veh.mini': '레트로 미니', 'veh.cybertruck': '사이버트럭', 'veh.f1': 'F1 포뮬러',
    'tel.parts': '파츠', 'tel.voxels': '복셀', 'tel.pitch': '피치',
    'demo.hint': '드래그로 궤도 회전 · 클릭 후 스크롤로 줌',
    'demo.loading': '복셀 볼륨 불러오는 중…',
    'demo.fallback': '이 브라우저는 WebGL2가 꺼져 있어, 네 가지 라이브 모드를 정지 이미지로 보여 드립니다.',
    'demo.clip': '클립', 'demo.camera': '카메라', 'demo.pixel': '픽셀', 'demo.outline': '1px 외곽선',
    'clip.idle': '대기', 'clip.move': '주행', 'clip.special': '기믹',
    'pitch.low': '저각 14° · 틈 0', 'pitch.side': '측면 8°',
    'works.label': '함께 쓰는 도구',
    'install.eyebrow': '빠른 설치', 'install.title': '한 줄이면 어떤 코딩 에이전트든',
    'install.sub': '스킬은 <code>SKILL.md</code>가 든 폴더 하나입니다. 쓰는 에이전트에 맞는 방법으로 설치하세요.',
    'install.tab1': '범용 · npx skills', 'install.tab2': 'Claude Code 플러그인', 'install.tab3': '수동 · clone',
    'install.note1': 'Claude Code, Antigravity, Codex / Open Agents, Cursor 등 SKILL.md를 읽는 모든 에이전트에서 동작합니다.',
    'install.note2': 'Claude Code 안에서 두 명령을 차례로 실행하세요. 저장소에 .claude-plugin/ 마켓플레이스 매니페스트가 들어 있습니다.',
    'install.note3': '다른 에이전트: <code>~/.gemini/config/skills/</code> (Antigravity) · <code>~/.agents/skills/</code> (Codex / Open Agents)',
    'install.ask': '설치 후 이렇게 말해 보세요',
    'prompt.1': '“Three.js로 귀에 스프링이 달린 복셀 고양이를 만들고 4대 QA 게이트까지 통과시켜줘”',
    'prompt.2': '“Godot 4에 minimal_reference를 띄우고 14°에서 틈 0을 확인해줘”',
    'prompt.3': '“MagicaVoxel .vox를 검증된 SVOX 번들로 바꿔줘”',
    'prompt.4': '“내 렌더러에 라이브 SPRITE STACK 디버그 뷰를 추가해줘”',
    'copy': '복사',
    'feat.eyebrow': '왜 T3 하이브리드인가', 'feat.title': '스프라이트 스태킹의 룩, 실제 볼륨의 수학',
    'f1.t': '저각도에서도 틈 제로',
    'f1.d': '2D 카드를 쌓는 방식은 카메라가 낮아지면 층 사이가 벌어지고 1복셀 칼날이 점선이 됩니다. T3는 각 파츠의 실제 3D 볼륨을 회전 박스 안에서 정확한 DDA로 레이마칭하므로 벌어질 슬라이스 자체가 없습니다.',
    'f2.t': '픽셀 단위 격자 스냅', 'f2.d': '카메라와 루트를 가상 FBO 텍셀 격자에 스냅해, 반 텍셀 미만으로 움직여도 가장자리 픽셀이 반짝이지 않습니다.',
    'f3.t': '분석적 역변형 + 스프링', 'f3.d': 'squash·twist·shear·wave를 샘플마다 정확히 되돌리고 스프링 2차 모션을 더합니다. UV·리토폴로지·스킨 웨이트가 필요 없습니다.',
    'f4.t': 'v1.1 프로덕션 업그레이드',
    'f4.d': '글로우 헤일로가 있는 6-슬롯 이미시브 · D24 깊이 버킷 타이브레이크(파츠 순서를 뒤집어도 <code>0 px</code>) · PerspectiveCamera 3D 월드 MRT 하이브리드 · 라이브 <code class="cy">SPRITE STACK</code> 검사 모드',
    'eng.eyebrow': '검증된 4개 엔진', 'eng.title': '하나의 계약, 네 개의 타깃, 같은 QA 게이트',
    'eng.web': '2-패스 MRT G-버퍼와 1px 외곽선, v1.1 Perspective 3D 월드 하이브리드 포함.',
    'eng.godot': 'Forward+와 Mobile(Vulkan) 두 렌더러가 픽셀 단위로 같은 결과를 냅니다.',
    'eng.unity': 'D3D11·D3D12에서 RenderGraph <code>ScriptableRendererFeature</code>, 0.63–0.75 ms.',
    'eng.blender': 'SVOX 에셋 추출 브리지: Blender에서 모델링하고 번들로 내보내 <code>validate</code> 0 오류.',
    'show.eyebrow': '실제로 보기', 'show.title': '최종 화면과 그 속을 실시간 와이프로',
    'show.sub': '관절형 차량 4대(39 파츠, 166,290 복셀)를 실시간 Three.js 3D 월드에 합성했습니다. 사선 띠마다 같은 프레임의 다른 라이브 뷰가 드러납니다.',
    'show.cap': '같은 포즈, 네 가지 라이브 모드: FINAL(셀 셰이딩 + 1px 외곽선) · SPRITE STACK(2D 슬라이스 카드) · 3D NORMALS · VOLUME AO',
    'cli.eyebrow': 'SVOX CLI · QA 게이트', 'cli.title': 'Python 표준 라이브러리만. 모든 어댑터가 통과해야 하는 4대 게이트.',
    'g1.t': '저각 14°, 틈 없음', 'g2.t': '서브텍셀 스냅', 'g4.t': '지면 · 루프 · 가림',
    'perf.t': 'GTX 1080, 640×360 ×3 기준 프레임 시간 (3파츠 레퍼런스 / 13파츠 기사).',
    'perf.h': '솔직한 포지셔닝: 픽셀 스케일 스프라이트가 많은 아이소메트릭·탑다운·사이드뷰 게임에 맞습니다. 저사양 모바일의 전체 화면 클로즈업에는 맞지 않습니다. 비용은 덮인 가상 픽셀 × 마치 길이에 비례합니다.',
    'foot.docs': '스킬 문서', 'foot.rel': '릴리스',
  };

  // Strings created by the live demo (demo.js reads them through HVS_I18N.t)
  var DYN = {
    en: {
      'mode.final': 'FINAL', 'mode.final.sub': 'Cel shading + 1px outline',
      'mode.stack': 'SPRITE STACK', 'mode.stack.sub': 'The same volume as 2D slice cards',
      'mode.normals': '3D NORMALS', 'mode.normals.sub': 'Voxel facet normals',
      'mode.ao': 'VOLUME AO', 'mode.ao.sub': 'Baked occlusion + self-shadow',
      'clip.excavator.idle': 'Engine idle · beacon spin', 'clip.excavator.move': 'Track drive', 'clip.excavator.special': 'Boom dig & dump',
      'clip.mini.idle': 'Idle bounce', 'clip.mini.move': 'Spirited drive', 'clip.mini.special': 'Rally hop-drift',
      'clip.cybertruck.idle': 'Idle · LED bar', 'clip.cybertruck.move': '4-wheel-steer drive', 'clip.cybertruck.special': 'Beast Mode lift + tonneau',
      'clip.f1.idle': 'Grid idle', 'clip.f1.move': 'Flat-out lap', 'clip.f1.special': 'Active DRS flap',
      'toast.copied': 'Copied to clipboard',
    },
    ko: {
      'mode.final': 'FINAL', 'mode.final.sub': '셀 셰이딩 + 1px 외곽선',
      'mode.stack': 'SPRITE STACK', 'mode.stack.sub': '같은 볼륨을 2D 슬라이스 카드로',
      'mode.normals': '3D NORMALS', 'mode.normals.sub': '복셀 면 노멀',
      'mode.ao': 'VOLUME AO', 'mode.ao.sub': '베이크 AO + 자기 그림자',
      'clip.excavator.idle': '공회전 · 경광등', 'clip.excavator.move': '무한궤도 주행', 'clip.excavator.special': '붐 굴착 & 덤프',
      'clip.mini.idle': '대기 바운스', 'clip.mini.move': '경쾌한 주행', 'clip.mini.special': '랠리 홉 드리프트',
      'clip.cybertruck.idle': '대기 · LED 바', 'clip.cybertruck.move': '4륜 조향 주행', 'clip.cybertruck.special': 'Beast Mode 리프트 + 톤노 커버',
      'clip.f1.idle': '그리드 대기', 'clip.f1.move': '풀 스로틀 랩', 'clip.f1.special': '액티브 DRS 플랩',
      'toast.copied': '클립보드에 복사했습니다',
    },
  };

  var EN = {};
  var lang = 'en';

  function nodes() { return document.querySelectorAll('[data-i18n],[data-i18n-html]'); }
  function capture() {
    nodes().forEach(function (el) {
      var html = el.hasAttribute('data-i18n-html');
      var k = el.getAttribute(html ? 'data-i18n-html' : 'data-i18n');
      if (!(k in EN)) EN[k] = el.innerHTML.trim();
    });
  }
  function t(k) {
    if (DYN[lang] && k in DYN[lang]) return DYN[lang][k];
    if (lang === 'ko' && k in KO) return KO[k];
    return k in EN ? EN[k] : (DYN.en[k] || null);
  }
  function setLang(l, persist) {
    lang = l === 'ko' ? 'ko' : 'en';
    document.documentElement.lang = lang;
    nodes().forEach(function (el) {
      var html = el.hasAttribute('data-i18n-html');
      var k = el.getAttribute(html ? 'data-i18n-html' : 'data-i18n');
      var v = lang === 'ko' && k in KO ? KO[k] : EN[k];
      if (v == null) return;
      el.innerHTML = v;   // trusted, first-party strings only
    });
    document.querySelectorAll('[data-lang]').forEach(function (b) {
      var on = b.getAttribute('data-lang') === lang;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    document.title = lang === 'ko'
      ? 'hybrid-voxel-sprite — 틈새 없이 움직이는 실시간 3D 복셀 스프라이트'
      : 'hybrid-voxel-sprite — Real-time 3D voxel sprites that never crack';
    if (persist) { try { localStorage.setItem('hvs-lang', lang); } catch (e) { /* storage blocked */ } }
    try {
      var u = new URL(location.href);
      if (u.searchParams.has('lang')) { u.searchParams.set('lang', lang); history.replaceState(null, '', u); }
    } catch (e) { /* file:// */ }
    window.dispatchEvent(new CustomEvent('hvs:lang', { detail: lang }));
  }
  function initialLang() {
    var q = null;
    try { q = new URLSearchParams(location.search).get('lang'); } catch (e) { /* */ }
    if (q === 'ko' || q === 'en') return q;
    try { var s = localStorage.getItem('hvs-lang'); if (s === 'ko' || s === 'en') return s; } catch (e) { /* */ }
    var nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'en';
    return /^ko\b/i.test(nav) ? 'ko' : 'en';
  }

  var toastTimer = 0;
  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1600);
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (res, rej) {
      var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? res() : rej(new Error('copy failed')); } catch (e) { rej(e); }
      document.body.removeChild(ta);
    });
  }

  function init() {
    capture();
    window.HVS_I18N = { t: t, get lang() { return lang; }, set: function (l) { setLang(l, true); } };
    setLang(initialLang(), false);
    document.querySelectorAll('[data-lang]').forEach(function (b) {
      b.addEventListener('click', function () { setLang(b.getAttribute('data-lang'), true); });
    });
    // install tabs
    var tabs = document.querySelectorAll('[data-tab]');
    tabs.forEach(function (tb) {
      tb.addEventListener('click', function () {
        var id = tb.getAttribute('data-tab');
        tabs.forEach(function (x) { x.setAttribute('aria-selected', x === tb ? 'true' : 'false'); });
        document.querySelectorAll('[data-panel]').forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== id; });
      });
    });
    // copy buttons
    document.querySelectorAll('[data-copy]').forEach(function (b) {
      b.addEventListener('click', function () {
        copyText(b.getAttribute('data-copy')).then(function () {
          b.classList.add('done'); setTimeout(function () { b.classList.remove('done'); }, 1400);
          toast(t('toast.copied'));
        }, function () { toast('⌘/Ctrl + C'); });
      });
    });
    // nav shadow on scroll
    var bar = document.querySelector('.topbar');
    var onScroll = function () { bar.classList.toggle('scrolled', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true }); onScroll();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
