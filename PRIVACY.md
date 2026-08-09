# 개인정보처리방침

**겹자막 (DualSub)** 크롬 확장 프로그램
최종 수정일: 2026년 8월 10일

## 요약

겹자막은 사용자 데이터를 수집하지 않습니다. 개발자가 운영하는 서버가 없으며,
확장이 다루는 모든 정보는 사용자의 브라우저 안에만 머무릅니다.

## 수집하지 않는 항목

다음 중 어느 것도 수집·전송·저장하지 않습니다.

- 이름, 이메일, 주소 등 개인 식별 정보
- 계정 정보, 로그인 자격 증명
- 시청 기록, 재생 이력, 검색어
- 위치 정보
- 기기 식별자, 광고 식별자
- 웹 사용 기록

## 브라우저에 저장되는 것

확장의 표시 설정만 `chrome.storage.local`(브라우저 로컬 저장소)에 보관합니다.

- 자막 글자 크기, 색상, 글꼴, 굵기, 외곽선, 배경, 자간, 행간
- 자막 표시 위치
- 싱크 보정값, 재생 속도
- 표시할 자막 언어 선택
- 화면 밝기 모드(밝게/어둡게)

이 값들은 사용자의 기기를 벗어나지 않습니다. 계정 동기화도 사용하지 않습니다.
확장을 삭제하면 함께 지워집니다.

## 자막 데이터 처리

확장은 스트리밍 서비스가 재생을 위해 이미 내려보내는 자막 파일을 읽어 화면에
표시합니다. 이 자막 내용은 메모리에만 두며 어디에도 전송하지 않습니다.

사용자가 팝업에서 `.srt 로 저장`을 직접 누른 경우에 한해, 표시 중인 자막이
사용자의 기기에 파일로 저장됩니다. 이 동작은 사용자가 명시적으로 요청할 때만
일어나며, 저장된 파일은 사용자의 기기에만 존재합니다.

## 외부 전송

없습니다. 확장은 분석 도구, 광고 네트워크, 오류 수집 서비스, 원격 설정 서버를
포함하지 않습니다. 외부에서 코드를 내려받아 실행하지 않으며, 웹폰트도
내려받지 않습니다.

## 권한을 사용하는 이유

| 권한 | 용도 |
|---|---|
| `storage` | 위에 적은 표시 설정을 브라우저에 저장 |
| `scripting` | 사용자가 '이 탭에 지금 적용하기'를 누를 때 현재 탭에 스크립트 삽입 |
| 호스트 권한 | 자막 트랙 목록과 자막 파일을 읽기 위해. 지원 서비스의 재생 페이지와 자막이 배포되는 CDN 도메인 |

## 소스 코드

전체 소스를 공개하고 있습니다. 위 내용은 코드로 확인할 수 있습니다.

https://github.com/bin5537/dualsub-extension

## 문의

https://github.com/bin5537/dualsub-extension/issues

---

# Privacy Policy

**DualSub (겹자막)** Chrome Extension
Last updated: August 10, 2026

## Summary

DualSub does not collect any user data. There is no developer-operated server,
and all information the extension handles stays within the user's browser.

## What we do not collect

- Personally identifiable information (name, email, address)
- Account information or authentication credentials
- Viewing history, playback history, or search queries
- Location data
- Device or advertising identifiers
- Web browsing activity

## What is stored in your browser

Only display preferences, kept in `chrome.storage.local`:

- Subtitle font size, color, family, weight, outline, background, spacing
- Subtitle position
- Sync offset and playback speed
- Selected subtitle languages
- Light/dark appearance

These values never leave your device. Account sync is not used. They are removed
when the extension is uninstalled.

## Subtitle data

The extension reads subtitle files that the streaming service already delivers
for playback, and renders them on screen. Subtitle content is held in memory
only and is never transmitted anywhere.

If the user explicitly clicks "Save as .srt" in the popup, the currently loaded
subtitles are written to a file on the user's own device. This happens only on
explicit user action.

## Third-party transmission

None. The extension contains no analytics, advertising, crash reporting, or
remote configuration. It does not load or execute remote code, and does not
fetch web fonts.

## Permissions

| Permission | Purpose |
|---|---|
| `storage` | Save the display preferences listed above |
| `scripting` | Inject the content script into the active tab when the user clicks "Apply to this tab" |
| Host permissions | Read subtitle track lists and subtitle files from supported services and the CDNs that serve them |

## Source code

The full source is public and can be reviewed:

https://github.com/bin5537/dualsub-extension

## Contact

https://github.com/bin5537/dualsub-extension/issues
