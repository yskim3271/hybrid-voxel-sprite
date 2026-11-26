// site.js — instant KO / EN toggle (no reload), install tabs, copy buttons + toast. Shared by index.html and changelog.html.
// English lives in the HTML; the English originals are captured from the DOM at start-up, so KO is the only
// dictionary that has to be maintained here. `?lang=ko|en` wins, then a saved choice, then the browser locale.
// Links marked data-keep-lang (index <-> changelog) always carry the current ?lang so the choice survives navigation.
(function () {
  'use strict';

  var KO = {
    'nav.demo': '라이브 데모', 'nav.back': '← 데모로 돌아가기', 'nav.features': '특징', 'nav.engines': '엔진', 'nav.install': '설치', 'nav.docs': '문서',
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
    'feat.sub': '복셀 스프라이트를 그리는 세 가지 방법. 낮은 카메라에서도 버티는 건 하나뿐입니다.',
    'c1.tag': '14° 이하에서 틈 발생', 'c1.t': '기존 2D 카드 스택',
    'c1.d': '낮은 각도에서 슬라이스 사이가 벌어지고, 1복셀 칼날은 점선으로 끊깁니다.',
    'c2.tag': '회전하면 뭉개짐', 'c2.t': '재복셀화 · 베이크 메시',
    'c2.d': '회전할 때마다 다시 샘플링해 가장자리가 계단지고, 얇은 디테일이 사라집니다.',
    'c3.tag': '틈 0 · 모든 각도', 'c3.t': 'T3 하이브리드 레이마치',
    'c3.d': '파츠마다 자기 박스 안에서 실제 볼륨을 레이마칭하고, 변형은 해석적으로 되돌린 뒤 1&nbsp;px 외곽선을 두릅니다.',
    'svg.blade': '점선이 된 칼날', 'svg.lost': '사라진 모서리', 'svg.ink': '1px 잉크 외곽선',
    'm1': '14° 저각에서 생기는 슬라이스 틈', 'm2': '격자 스냅 시 서브텍셀 픽셀 떨림', 'm3': 'GTX 1080, 640×360 ×3 기준 프레임당',
    'eng.eyebrow': '검증된 4개 엔진', 'eng.title': '하나의 계약, 네 개의 타깃, 같은 QA 게이트',
    'eng.web': '2-패스 MRT G-버퍼와 1px 외곽선, v1.1 Perspective 3D 월드 하이브리드 포함.',
    'eng.godot': 'Forward+와 Mobile(Vulkan) 두 렌더러가 픽셀 단위로 같은 결과를 냅니다.',
    'eng.unity': 'D3D11·D3D12에서 RenderGraph <code>ScriptableRendererFeature</code>, 0.63–0.75 ms.',
    'eng.blender': 'SVOX 에셋 추출 브리지: Blender에서 모델링하고 번들로 내보내 <code>validate</code> 0 오류.',
    'show.eyebrow': '실제로 보기', 'show.title': '최종 화면과 그 속을 실시간 와이프로',
    'show.sub': '관절형 차량 4대(39 파츠, 166,290 복셀)를 실시간 Three.js 3D 월드에 합성했습니다. 사선 띠마다 같은 프레임의 다른 라이브 뷰가 드러납니다.',
    'show.cap': '같은 포즈, 네 가지 라이브 모드: FINAL(셀 셰이딩 + 1px 외곽선) · SPRITE STACK(2D 슬라이스 카드) · 3D NORMALS · VOLUME AO',
    'foot.docs': '스킬 문서', 'foot.rel': '릴리스', 'foot.log': '변경 이력',
    // live demo · renderer options drawer
    'r.btn': '렌더러', 'r.surface': '복셀 표면', 'r.crisp': '또렷한 DDA', 'r.smooth': '매끈한 Iso',
    'r.bands': '셀 단계', 'r.bandsSmooth': '부드럽게', 'r.light': '조명 프리셋',
    'r.studio': '스튜디오', 'r.daylight': '한낮', 'r.sunset': '노을', 'r.cyber': '사이버 림',
    'r.px': '픽셀 배율', 'r.passes': '셰이더 패스', 'r.selfShadow': '자기 그림자', 'r.ao': '볼륨 AO', 'r.rim': '림 라이트',
    'r.ground': '지면 그림자', 'r.emissive': '발광', 'r.snap': '픽셀 스냅', 'r.reset': '초기화',
    // changelog.html
    'log.eyebrow': '버전 히스토리', 'log.title': '변경 이력',
    'log.sub': 'hybrid-voxel-sprite 에이전트 스킬의 모든 릴리스. 최신 버전이 맨 위에 있습니다.',
    'log.back': '라이브 데모로 돌아가기',
    'log.latest': '최신', 'log.initial': '첫 릴리스',
    'v11.t': '라이브 SPRITE STACK, Perspective 3D 월드, 인터랙티브 데모',
    'v11.d': '같은 T3 계약 위에 디버그 뷰, 시네마 합성, 하드서피스 리깅, 배포 경로를 더한 프로덕션 업데이트입니다.',
    'g.render': '렌더링', 'g.workflow': '워크플로', 'g.dist': '배포', 'g.core': '코어', 'g.cli': 'SVOX CLI', 'g.engines': '엔진 · QA',
    'v11.1': '라이브 <code>SPRITE STACK</code> 모드(<code>mode == 2</code>): 가로 2D 카드 DDA 마치로 같은 볼륨을 슬라이스 카드로 검사',
    'v11.2': 'PerspectiveCamera 3D 월드 MRT 하이브리드 + 액터 마스크 기반 시네마 포스트 FX',
    'v11.3': '6-슬롯 이미시브 팔레트 + 포스트 글로우 헤일로',
    'v11.4': 'D24 깊이 버킷 타이브레이크: 파츠 순서를 뒤집어도 <code>0 px</code> 차이',
    'v11.5': '3-뷰 턴어라운드 시각 비교(visual-diff) 워크플로',
    'v11.6': '멀티 클립 프레이밍: 모든 클립의 합집합 박스로 화면 밖 이탈 방지',
    'v11.7': '하드서피스 유압 실린더 · 휠 리깅',
    'v11.8': 'GitHub Pages 인터랙티브 WebGL2 데모',
    'v11.9': '<code>.claude-plugin</code> 마켓플레이스 지원',
    'v10.t': '코어 T3 렌더러, SVOX CLI, 4개 엔진 어댑터',
    'v10.d': '관절형 복셀 스프라이트를 위한 첫 공개 버전입니다.',
    'v10.1': '파츠별 OBB 안에서 하는 T3 레이마칭',
    'v10.2': '해석적 역변형(squash · twist · shear · wave) + 스프링 2차 모션',
    'v10.3': 'Python 표준 라이브러리 CLI: <code>init-demo</code> · <code>from-vox</code> · <code>from-strip</code> · <code>bake-normal-ao</code> · <code>validate</code> · <code>pack-atlas</code>',
    'v10.4': '검증된 4개 엔진 어댑터: WebGL2 / Three.js · Godot 4.7.2 · Unity 6 URP · Blender 5.3',
    'v10.5': '필수 QA 게이트 4종: G1 저각 틈 · G2 서브텍셀 스냅 · G3 역변형 오차 · G4 지면 · 루프 · 가림',
    'log.notes': 'GitHub 릴리스 노트', 'log.skill': 'SKILL.md 보기', 'log.compare': '변경 내역 비교',
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
  var enTitle = document.title;

  function keepLangLinks() {
    document.querySelectorAll('a[data-keep-lang]').forEach(function (a) {
      var base = a.getAttribute('data-base-href');
      if (base == null) { base = a.getAttribute('href'); a.setAttribute('data-base-href', base); }
      var hash = '', i = base.indexOf('#');
      if (i >= 0) { hash = base.slice(i); base = base.slice(0, i); }
      a.setAttribute('href', (base || './') + '?lang=' + lang + hash);
    });
  }

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
    var koTitle = document.documentElement.getAttribute('data-title-ko');
    document.title = lang === 'ko' && koTitle ? koTitle : enTitle;
    keepLangLinks();
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
    if (!el) return;
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
