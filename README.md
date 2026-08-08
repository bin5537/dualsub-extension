# 겹자막 — 이중 자막 크롬 확장

넷플릭스·디즈니+·티빙에 **등록된 자막을 직접 읽어와서** 두 번째 언어를 영상 위에 겹쳐 보여준다.
사이트 자체 자막(한글)은 그대로 켜둔 채로 쓰면 그대로 이중 자막이 된다.

자막 파일을 따로 구할 필요가 없다 — 서비스가 내려주는 자막을 그대로 쓴다.

## 설치

```bash
git clone https://github.com/bin5537/dualsub-extension.git
```


1. 크롬 주소창에 `chrome://extensions` 입력
2. 오른쪽 위 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램을 로드** 클릭 → `c:\b1n2da\dualsub-ext` 폴더 선택

## 사용법

1. 넷플릭스/디즈니+/티빙에서 영상 재생 (사이트 자막은 한글로 켜둔다)
2. 툴바의 겹자막 아이콘 클릭
3. **자동 선택 언어**를 영어로 두면 영어 자막이 자동으로 잡혀 표시된다.
   원하는 트랙을 직접 고르고 싶으면 "추가로 띄울 자막"에서 선택
4. 스타일(크기·색·글꼴·외곽선·배경)과 위치를 팝업에서 조절

### 단축키

| 키 | 기능 |
|---|---|
| Shift + ← / → | 싱크 −0.5초 / +0.5초 |
| Shift + ↑ / ↓ | 글자 크기 |
| Alt + 드래그 | 자막 위치 이동 |

## 동작 원리

```
hook.js (MAIN world)      페이지의 fetch·XHR·JSON.parse 를 감싸 자막 트랙 목록만 읽음
      ↓ postMessage
content.js (isolated)     트랙 선택 → 오버레이 렌더링 → video.currentTime 으로 싱크
      ↓ chrome.runtime
background.js (SW)        자막 URL 을 대신 받아옴(CORS 회피) → parser.js 로 파싱
```

- **넷플릭스**: 매니페스트 응답의 `timedtexttracks` 에서 언어별 자막 URL을 얻어 직접 받는다.
  플레이어는 한 번에 한 트랙만 로드하므로 두 번째 언어는 확장이 따로 받아온다.
  WebVTT 프로필이 있으면 우선 쓰고, 없으면 TTML(tick 단위 포함)을 파싱한다.
- **HLS (디즈니+ 등)**: 마스터 재생목록의 `EXT-X-MEDIA:TYPE=SUBTITLES` 에서 자막 재생목록을
  찾아 세그먼트를 모아 붙인다. 세그먼트별 `X-TIMESTAMP-MAP` 으로 시간축을 보정한다.
- **DASH (티빙·웨이브 등 국내 OTT)**: `.mpd` 의 자막 `AdaptationSet` 에서 `BaseURL` 체인을
  이어 자막 URL을 만든다. `SegmentTemplate` 방식이라 URL을 못 만들면 진단 목록에 남긴다.
- DRM은 영상·음성에만 걸려 있고 자막은 평문이라 우회 없이 읽을 수 있다.

## 자막이 안 잡힐 때

1. 팝업 아래 **"감지된 자막 후보 요청"** 을 펼치면 그 사이트가 실제로 어떤 자막 요청을
   보내는지 URL 목록이 보인다. 티빙처럼 구조가 불확실한 사이트는 이걸 캡처해서 알려주면
   해당 어댑터를 맞춰 넣을 수 있다.
2. 영상에 자막이 구워져(burned-in) 있으면 읽을 자막 트랙 자체가 없다.
3. 임시 방편으로 팝업 하단에서 `.srt` / `.vtt` 파일을 직접 열어 띄울 수 있다.
   이 경로는 `<video>` 가 있는 어느 사이트에서든 동작한다.

## 파일 구성

| 파일 | 역할 |
|---|---|
| `src/hook.js` | 네트워크 후킹 (MAIN world) |
| `src/content.js` | 오버레이 렌더링·싱크·설정 |
| `src/background.js` | 자막 다운로드·HLS 조립 |
| `src/parser.js` | WebVTT / SRT / TTML 파서 |
| `src/popup.html·js` | 설정 UI |
| `tools/make-icons.js` | 아이콘 PNG 생성 |

## 테스트

파서와 후킹 로직은 Node 로 검증한다 (170개 케이스).

```bash
npm install   # @xmldom/xmldom — 테스트에서 TTML 파싱에만 쓴다
npm test
```

| 파일 | 내용 |
|---|---|
| `test/test-parser.js` | SRT·VTT·TTML 파싱, 이진 탐색, 중복 병합 (44) |
| `test/test-hook.js` | 넷플릭스 매니페스트·HLS·JSON.parse 후킹, 예외 견고성 (126) |

## 한계

- 사이트가 자막 요청 구조를 바꾸면 어댑터를 손봐야 한다.
- 티빙은 실제 요청 구조를 확인하지 못했다 — 위의 진단 목록으로 확인이 필요하다.

## 문서

- [모바일에서 쓰기](docs/mobile.md) — 안드로이드 크로미엄 계열 브라우저에 설치하는 법
- [넷플릭스 자막 트랙 확인](docs/netflix-track-check.txt) — 자막이 안 잡힐 때 콘솔에서 직접 확인하는 스니펫
