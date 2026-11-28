// site.js — instant KO / EN toggle (no reload), install tabs, copy buttons + toast. Shared by index.html and changelog.html.
// English lives in the HTML; the English originals are captured from the DOM at start-up, so KO is the only
// dictionary that has to be maintained here. `?lang=ko|en` wins, then a saved choice, then the browser locale.
// Links marked data-keep-lang (index <-> changelog) always carry the current ?lang so the choice survives navigation.
(function () {
  'use strict';

  var KO = {
    'nav.demo': '라이브 데모', 'nav.back': '← 데모로 돌아가기', 'nav.engines': '엔진', 'nav.install': '설치', 'nav.docs': '문서',
    'hero.badge': '오픈 소스 · MIT 라이선스 · v2.4',
    'hero.title': '픽셀 아트 스타일의<br><span class="accent">3D 복셀 스프라이트</span>',
    'hero.lede': '파츠별 3D 복셀 볼륨을 실시간으로 렌더링하는 에이전트 스킬입니다. 픽셀 아트 외곽선과 2D 스프라이트 스태킹의 느낌을 유지하면서, 카메라 각도에 관계없이 깔끔하게 움직입니다.',
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
    'install.tab1': '범용 · npx skills', 'install.tab2': 'Claude Code 플러그인', 'install.tab3': '수동 · clone',
    'install.note2': 'Claude Code 안에서 두 명령을 차례로 실행하세요. 저장소에 .claude-plugin/ 마켓플레이스 매니페스트가 들어 있습니다.',
    'install.note3': '다른 에이전트: <code>~/.gemini/config/skills/</code> (Antigravity) · <code>~/.agents/skills/</code> (Codex / Open Agents)',
    'install.ask': '설치 후 이렇게 말해 보세요',
    'prompt.1': '“복셀 고양이와 강아지를 만들어줘”',
    'prompt.2': '“걷기와 검 휘두르기 모션이 있는 쿼터뷰 RPG 기사를 만들어줘”',
    'prompt.3': '“탑다운 레이싱 게임용 복셀 F1 머신과 레트로 미니를 만들어줘”',
    'prompt.4': '“간판이 돌아가고 배달 스쿠터가 서 있는 복셀 카페 씬을 만들어줘”',
    'copy': '복사',
    'eng.eyebrow': '어댑터', 'eng.title': '4개 엔진을 지원합니다',
    'show.eyebrow': '쇼케이스', 'show.title': '실시간 렌더링 예시',
    'cap.title': '대형 메가스트럭처',
    'cap.sub': '약 1000&nbsp;u 크기의 대형 복셀 구조물 예시입니다. 2D 콘셉트 아트(패널 01)에서 실시간 WebGL2(패널 02–04)까지 쿼드당 16&nbsp;B인 <code>quad16</code> 포맷으로 패킹합니다. 정사영 3-뷰만으로 완전히 오프라인에서 만들거나(모드 B1), 원하는 공급자의 3D 메시를 선택해 쓸 수 있습니다(모드 B2).',
    'cap.more': '버전 히스토리에서 v2.4 변경 내역 보기',
    'foot.docs': '스킬 문서', 'foot.rel': '릴리스', 'foot.log': '변경 이력',
    // live demo · renderer options panel
    'r.surface': '복셀 표면', 'r.crisp': '또렷한 DDA', 'r.smooth': '매끈한 Iso',
    'r.bands': '셀 단계', 'r.bandsSmooth': '부드럽게',
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
    // v2.4.0
    'v24.t': '선택형 3D 메시 입력, 교체 가능한 모델 공급자 & 구조 인식 셰이더',
    'v24.d': 'Track B에서 두 모드를 고를 수 있습니다. 기본값은 완전히 오프라인인 3-뷰 비주얼 헐(<b>모드 B1</b>)이고, 유기체·장식·깊은 조형에는 원하는 공급자에서 구한 3D <code>.glb</code> / <code>.gltf</code> 메시(<b>모드 B2</b>)를 선택해 쓸 수 있습니다.',
    'g.mesh': '3D 메시 입력 & 공급자 추상화', 'g.shaders': '렌더링 & 셰이더', 'g.verify': '검증',
    'v24.1': 'Track B 모드를 명시적으로 선택: <b>B1</b>(기본값, 100% 오프라인, 외부 3D 도구·키 불필요) 또는 <b>B2</b>(선택형 3D 메시). 스킬이 3D 입력을 가정하지 않고 먼저 묻습니다',
    'v24.2': '<code>mesh_source.mjs</code>의 교체 가능한 모델 공급자: <code>local</code> 파일(기본값), <code>command</code>(셸 없이 실행하는 임의 CLI · 로컬 오픈소스 모델), <code>manual</code> 웹 UI · DCC 수동 전달, 선택형 <code>tripo</code> API 어댑터, 그 밖의 서비스는 <code>registerProvider()</code>로 추가. 검증, SHA-256 캐시, 비밀 값 마스킹 제공',
    'v24.3': '<code>mesh_to_voxel.mjs</code>: CPU 6-뷰 정렬 시트, 보수적 복셀화, 내부 채움, 좌우 대칭, 팔레트 · 발광 규칙, 디테일 존 카빙, <b>통합 AO 1회 굽기</b>와 wave 자동 앵커를 갖춘 다중 파트 분할',
    'v24.4': '구조 인식 잉크(<code>capSoftInk</code>): 곡면의 1-복셀 계단마다 생기던 검은 선을 없애고 1&nbsp;px 외곽 실루엣과 실제 단차는 유지. 하드서피스 에셋 변화 <code>0 px</code>',
    'v24.5': '클리핑 없이 형태를 살리는 발광, 벨벳 갑각 · 따뜻한 뼈 그림자 램프, 뿌리 이음매 이동 <code>0 px</code>인 앵커 wave 모드(<code>\'box\'</code> / <code>\'ellipsoid\'</code>). Early-Z 유지',
    'v24.6': '새 <code>test_mesh_harness.mjs</code> <code>32/32</code>(합성 <code>.glb</code>, 네트워크 호출 0) · 키트 <code>78/78</code> · Python 스위트 26 통과, 0 실패 · 바이트 단위로 같은 스킬 미러',
    'v24.c1': '하드서피스 캐리어 · 메시 기반 제작',
    'v24.c2': '금·상아 링형 구조물 · 회전 링 + 코어',
    'v24.c3': '유기체 거대 개체 · 앵커 wave 촉수',
    'v24.c4': '구조 인식 잉크 · 적용 전 → 후',
    'v24.hint': '패널 01은 원본 2D 콘셉트 아트, 패널 02–04는 모드 B2로 만든 에셋의 실시간 WebGL2 렌더입니다. 마지막 시트는 같은 에셋과 카메라로 셰이더 업데이트 전후를 비교합니다. 클릭하면 원본 해상도로 열립니다.',
    'log.ref04b2': 'Track B 모드 & 메시 입력 (04)',
    // v2.3.0
    'log.checkpoint': '체크포인트', 'log.ref04': '메가스트럭처 파이프라인 (04)', 'log.ref12': '04 부록 A 보기',
    'g.gallery': '적용 예시 · 콘셉트 레퍼런스 → 실시간 WebGL2',
    'g.format': '포맷', 'g.qa': 'QA · 워크플로', 'g.pipeline': '파이프라인', 'g.tools': '도구 · 게이트',
    'v23.t': '메가스트럭처 quad16 포맷, 범용 추상화 & Track A/B 스킬 재구성',
    'v23.d': '대형 구조물 트랙(<code>svox.mega/v2.3</code>)의 핵심 업데이트입니다. 16바이트 인스턴스 쿼드로 곡면 메시 용량을 약 5배 줄이고, 머티리얼·색상 게이트를 범용 추상화했으며, 스킬 문서를 두 트랙으로 직관화했습니다.',
    'v23.1': '<code>quad16</code> 매크로 포맷(<code>16 B/quad</code>): 인덱스 버퍼와 65,535 정점 상한 없이 파트당 인스턴스 1드로우 — 곡면·유기체 선체에서 v2.2 대비 5.06–5.75배 절감',
    'v23.2': '<code>MEGA_V23_BUDGET</code>을 <code>12 MiB</code> · 16드로우 · 1.2M 삼각형 · Δ ≤ 2.5 ms로 확장해 실루엣 밀도를 유지한 채 16단계 듀얼 스케일 AO 적용 가능',
    'v23.3': '확장 가능한 4비트 <code>matTag</code> 프리셋(<code>hard_surface</code>, <code>ornate_stone</code>, <code>organic_bio</code>) + 70/30 비주얼 레스트 플레이팅 & 1px 잉크 윤곽선',
    'v23.4': '<code>SKILL.md</code>와 <code>04</code> 문서를 <b>Track A</b>(관절형 스프라이트) · <b>Track B</b>(메가스트럭처) 두 트랙으로 재구성하고 특정 프로젝트 의존성 제거',
    'v23.5': '범용 <code>generic_megastructure</code> 아키타입(<code>assetId</code>), 멀티 큐 G5 사용자 정의 HSV 강조색 밴드(<code>--bands</code>, 랩어라운드 색조 지원), 촉수형 에셋용 선체 전용 G5(<code>computeHullSilhouetteIoU</code>) 추가',
    'v23.6': '의존성 없는 Node 키트 자체 테스트를 <code>78/78</code> 체크(<code>test_mega_kit.mjs</code>)로 확장, Python CLI 및 문서 링크 검증 통과',
    'v23.c1': '하드서피스 대형 구조물 예시',
    'v23.c2': '지오메트리 · 룩데브 분해도',
    'v23.c3': '금·상아 링형 구조물 예시',
    'v23.c4': '유기체 촉수형 거대 개체 예시',
    'v23.hint': '패널 01은 원본 2D 콘셉트 아트, 패널 02–04는 실시간 WebGL2 렌더입니다. 클릭하면 원본 해상도로 열립니다. (체크포인트 릴리스 — 모바일 LOD 및 스트리밍 최적화는 추후 예정)',
    // v2.2.0 · v2.0.0
    'v22.t': '20 B/정점 packed20, 멀티 큐 G5, 4단계 스컬프트 루프',
    'v22.d': '같은 4 MiB 안에 더 촘촘한 대형 구조물 지오메트리를 담고, 내부가 밋밋한 모델은 외곽선만으로 콘셉트 비교 게이트를 통과할 수 없게 했습니다.',
    'v22.1': '<code>svox.mega/v2.2</code> <code>packed20</code>: 정점당 20 B(Int16 위치 + 베벨 힌트, Int8 노멀 + 마이크로 AO, Uint8 색상 · 이미시브 · 룩데브 태그) + Uint16 인덱스로 바이트당 지오메트리 2.4배',
    'v22.2': '멀티 큐 G5: 실루엣 IoU + 내부 엣지 F1 / 챔퍼 + 강조색 밴드 분포',
    'v22.3': '클레이 → 1차 형태 → 메소 킷배시 → 룩데브 4단계 루프를 실시간 엔진 스튜디오 프리뷰에서 검수',
    'v22.4': '균일한 벽돌 타일링을 없앤 70/30 비주얼 레스트 하드서피스 셰이더',
    'v20.t': '메가스트럭처 트랙',
    'v20.d': '대형 구조물(~500–1500 u)을 위한 두 번째 트랙입니다. 레이마칭 대신 미리 베이크한 멀티 스케일 그리디 메시로 래스터화합니다. 관절형 T3 스프라이트 트랙은 그대로입니다.',
    'v20.1': '3-뷰 비주얼 헐 카빙 + 가려진 영역 콜아웃 시트(<code>detail_zones.json</code>)',
    'v20.2': '매크로 / 메소 / 마이크로 멀티 스케일 그리디 메시 + 인스턴스 킷배시 프리팹',
    'v20.3': '듀얼 스케일 AO: 코너별 마이크로 AO + 매크로 캐비티 AO',
    'v20.4': '의존성 없는 Node 키트: <code>mega_voxel_kit.mjs</code> · <code>mega_diff_utils.mjs</code>',
    'v20.5': 'G5 콘셉트 비교 게이트와 G6 메가스트럭처 성능 게이트',
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
