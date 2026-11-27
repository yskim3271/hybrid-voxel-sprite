// site.js — instant KO / EN toggle (no reload), install tabs, copy buttons + toast. Shared by index.html and changelog.html.
// English lives in the HTML; the English originals are captured from the DOM at start-up, so KO is the only
// dictionary that has to be maintained here. `?lang=ko|en` wins, then a saved choice, then the browser locale.
// Links marked data-keep-lang (index <-> changelog) always carry the current ?lang so the choice survives navigation.
(function () {
  'use strict';

  var KO = {
    'nav.demo': '라이브 데모', 'nav.back': '← 데모로 돌아가기', 'nav.engines': '엔진', 'nav.install': '설치', 'nav.docs': '문서',
    'hero.badge': '오픈 소스 · MIT 라이선스 · v2.3',
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
    'cap.title': '캐피털 메가스트럭처 (체크포인트)',
    'cap.sub': '약 1000&nbsp;u 크기의 히어로 캐피털 함선 3척을 2D 콘셉트 아트(패널 01)에서 실시간 WebGL2(패널 02–04)까지 구현했습니다. 쿼드당 16&nbsp;B인 <code>quad16</code> 포맷으로 패킹합니다.',
    'cap.more': '버전 히스토리에서 개선 전후 수치와 체크포인트 노트 보기',
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
    // v2.3.0
    'log.checkpoint': '체크포인트', 'log.ref04': '캐피털 함선 파이프라인 (04)', 'log.ref12': '04 §12 보기',
    'g.gallery': '콘셉트 레퍼런스 → 실시간 WebGL2', 'g.evo': '개선 내역 · v2.0 → v2.2 → v2.3', 'g.ships': '함선별 개선 전 → 후',
    'g.tech': '기술 하이라이트', 'g.notes': '체크포인트 노트 · 남은 개선 과제',
    'g.format': '포맷', 'g.qa': 'QA · 워크플로', 'g.pipeline': '파이프라인', 'g.tools': '도구 · 게이트',
    'v23.t': '울트라 HD 캐피털 함선: quad16 인스턴스 쿼드, 12 MiB 히어로 예산, 3개 진영 기함',
    'v23.d': '메가스트럭처 / 캐피털 함선 트랙에 새 <code>svox.mega/v2.3</code> 포맷을 더하고, 약 1000&nbsp;u 크기의 히어로 캐피털 함선 3척으로 2D 콘셉트 아트부터 실시간 WebGL2 엔진까지 전 과정을 검증했습니다. 이번 버전은 체크포인트 릴리스입니다. 아래 수치는 모두 실측값이며, 남은 과제는 맨 끝에 정리했습니다.',
    'v23.c2': 'Vanguard T2 · 지오메트리 · 룩데브 분해도',
    'v23.hint': '각 시트의 패널 01은 원본 2D 콘셉트 아트, 패널 02–04는 실시간 WebGL2 프레임입니다. 시트를 클릭하면 원본 해상도로 열립니다.',
    'evo.h': '파이프라인', 'evo.fmt': '매크로 지오메트리', 'evo.noidx': '인덱스 버퍼 없음',
    'evo.cap': '파트당 정점 상한', 'evo.cap2': '65,535 (큰 선체는 영역으로 분할)', 'evo.cap3': '없음',
    'evo.size': '곡면 선체 용량', 'evo.budget': 'G6 예산',
    'evo.ao': '매크로 캐비티 AO', 'evo.ao1': '듀얼 스케일 (마이크로 + 매크로)', 'evo.ao2': '2–6단계 (용량 제약)', 'evo.ao3': '모든 히어로 함선 16단계 (최대 256)',
    'evo.g5': 'G5 콘셉트 비교', 'evo.g51': '실루엣 IoU', 'evo.g52': '+ 엣지 F1 / 챔퍼 + 앰버 / 시안 밴드', 'evo.g53': '+ 선체 전용(Hull-Only) IoU ≥ 0.86',
    'evo.shade': '셰이딩', 'evo.sh1': '셰이더 마이크로 디테일', 'evo.sh2': '70/30 비주얼 레스트 하드서피스', 'evo.sh3': '진영별 <code>matTag 6/7/8</code>',
    'evo.test': '키트 자체 테스트',
    'ship.v.tag': '테란 하드서피스 항모', 'ship.a.tag': '에테르 금 · 상아 신전 함선', 'ship.s.tag': '스웜 생체 유기체 리바이어던',
    'm.tris': '삼각형', 'm.vox': '매크로 복셀', 'm.ao': '매크로 AO', 'm.ao16': '16단계', 'm.g5edge': 'G5 정사영 엣지 F1',
    'm.hangar': '격납고', 'm.engines': '엔진', 'm.hull': '선체', 'm.g5': 'G5 히어로', 'm.features': '디테일',
    'm.hulliou': '선체 전용 IoU (상 / 측 / 정면)', 'm.allpass': '전부 통과',
    'v.h0': 'Y축 대칭 타협안', 'v.h1': '좌현 / 우현이 진짜 비대칭인 1.0 u/vox 격납고, 후방 시안 포털 1개',
    'v.e1': '0.95 u/vox 베벨 처리한 2×3 추진기 포드, 4 u 간격',
    'a.hull': '2.2 u/vox <code>quad16</code> 통합 선체, 섹터 이음새 0개',
    'a.feat': '진짜 원통형 워프 포털(위상 홈 6개) · 8면 길쭉한 다이아몬드 크리스털(<code>rotateBob</code>) · 서로 교차하는 금색 자이로 링 3개(<code>rotate</code>) · <code>matTag 7</code> 금 · 상아 신전 셰이더',
    's.feat': '곡면 돔 갑각 · 상아색 U자 하악과 갈비뼈형 턱 케이지 · 휘어진 송곳니 46개 · 마젠타 생체 낭 82개 · 빨판이 달린 Catmull-Rom 웨이브 촉수(2.5 u/vox) · <code>matTag 6/8</code> 유기 키틴 · 생체 캐비티 셰이더',
    'v23.1': '<code>svox.mega/v2.3</code> <code>quad16</code>: 그리디 쿼드 하나가 공유 단위 쿼드의 16바이트 인스턴스 하나이고, 파트당 <code>drawElementsInstanced</code> 한 번으로 그립니다. 인덱스 버퍼와 65,535 정점 상한이 없고, 곡면 선체에서 v2.2보다 5.06–5.75배 작으며, 삼각형 단위로 v2.2 메셔와 동일합니다',
    'v23.2': '<code>MEGA_V23_BUDGET</code> 히어로 예산: 12 MiB · 드로우 16 · 삼각형 1.2M · Δ ≤ 2.5 ms. 이제 복셀 크기, AO 단계, 돔 곡률을 서로 맞바꾸지 않아도 됩니다',
    'v23.3': '진영별 셰이더: <code>matTag 6</code> 유기 키틴, <code>7</code> 화려한 금 · 상아 신전, <code>8</code> 생체 발광 캐비티. 격납고 반사광은 Vanguard 전용으로 유지',
    'v23.4': '선체 전용 G5 게이트(<code>computeHullSilhouetteIoU</code>): 촉수가 어떻게 휘든 갑각 실루엣만 따로 채점',
    'v23.5': '의존성 없는 Node 키트 자체 테스트: <code>69/69</code> 통과 (v2.0 39 + v2.2 16 + v2.3 14)',
    'v23.n1': 'Aether P2의 정사영 IoU(<code>0.799 / 0.688 / 0.730</code>)는 고정된 <code>r = 78</code> 발진 보어 제약 때문에 아직 목표치 0.85에 못 미칩니다',
    'v23.n2': 'Swarm Z2: 원근 히어로 뷰의 촉수 포즈가 정사영 포즈와 다르고, Clay 뷰에서 잘게 꺾인 곡면 계단에 윤곽선이 촘촘하게 보입니다',
    'v23.n3': 'Vanguard T2: 분해도 시트의 Zone C 레일건 프레이밍을 한 번 더 다듬어야 하며, 측면 뷰 단독 엣지 F1은 <code>0.538</code>입니다(정사영 평균 <code>0.560</code>은 통과)',
    'v23.n4': '저사양 · 모바일 LOD와 점진적 스트리밍 최적화는 비주얼 완성도 작업 이후에 진행할 예정입니다',
    // v2.2.0 · v2.0.0
    'v22.t': '20 B/정점 packed20, 멀티 큐 G5, 4단계 스컬프트 루프',
    'v22.d': '같은 4 MiB 안에 더 촘촘한 캐피털 함선 지오메트리를 담고, 내부가 밋밋한 모델은 외곽선만으로 콘셉트 비교 게이트를 통과할 수 없게 했습니다.',
    'v22.1': '<code>svox.mega/v2.2</code> <code>packed20</code>: 정점당 20 B(Int16 위치 + 베벨 힌트, Int8 노멀 + 마이크로 AO, Uint8 색상 · 이미시브 · 룩데브 태그) + Uint16 인덱스로 바이트당 지오메트리 2.4배',
    'v22.2': '멀티 큐 G5: 실루엣 IoU + 내부 엣지 F1 / 챔퍼 + 앰버 / 시안 밴드 분포',
    'v22.3': '클레이 → 1차 장갑 → 메소 킷배시 → 룩데브 4단계 루프를 실제 엔진 기반 <code>capital_studio.html</code> 하네스에서 검수',
    'v22.4': '균일한 벽돌 타일링을 없앤 70/30 비주얼 레스트 하드서피스 셰이더',
    'v20.t': '메가스트럭처 / 캐피털 함선 트랙',
    'v20.d': '약 1000 u 크기 함선을 위한 두 번째 트랙입니다. 레이마칭 대신 미리 베이크한 멀티 스케일 그리디 메시로 래스터화합니다. 관절형 T3 스프라이트 트랙은 그대로입니다.',
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
