# 자유여행(FIT) 등록 형식

투어·티켓·체험·교통·호텔 같은 자유여행 상품을 ERP `자유여행 > 상품관리`에 **비공개**로 등록한다. 패키지(`product_import_prepare`)와 별개 흐름이다.

## 순서

1. `product_import_source`(seasonMode는 `excluded`)로 원문을 기록한다. 원문이 SPA라 비면 브라우저로 본문·옵션·가격·일정·포함/불포함·유의사항·취소규정·사진 주소를 읽어 `product_import_source_supplement`로 보충한다.
2. `product_import_images`로 사진을 한 번에 모은다(최대 20장). 업체 로고가 박힌 광고 이미지·배너는 제외한다.
3. `product_import_lookups`로 도시·담당자 표시명을 확인한다. 거래처(agentLabel)는 ERP 거래처 자동완성의 정확한 이름이다(원문 공급사 거래처가 없으면 사용자에게 확인, 테스트는 위임받은 기본 거래처).
4. `product_fit_prepare({id, fit})` → `product_fit_review({id})` → 요약을 사용자에게 보여준다.
5. 사용자가 등록을 지시했거나 맡겼으면 `product_fit_register({id, companyId, accountName, planDigest, delegation:{explicitUserRequest:true, userInstruction:'사용자 원문'}})`.
6. `product_import_get({id})`의 `fit.stage`로 진행을 확인한 뒤 `afterRevision:revision,waitMs:30000`으로 변경을 기다린다. 변화가 없으면 원문·초안을 다시 읽거나 출력하지 않는다. `fit.status='completed'`와 `fit.result.erpUrl/previewUrl`을 보고한다. `failed`면 원인과 장부의 저장 여부를 확인하고 허용된 단계만 같은 호출로 이어서 진행한다.

## fit 형식

```json
{
  "master": {
    "category": "관광",               // 관광|티켓|체험|교통|숙박|호텔|WIFI/SIM
    "cityLabel": "방콕(BKK)", "managerLabel": "데모13 (기본부서)", "agentLabel": "거래처",
    "title": "[아속 출발] 아유타야 선셋 리버크루즈 반일 투어",
    "shortDescription": "한 줄 요약(200자)", "description": "상품 설명(줄바꿈 가능)",
    "badges": ["즉시확정", "한국어가이드"],  // 최대 3개, 각 8자, 쉼표 금지
    "status": "비공개",                // 비공개(기본)|판매대기. 판매 공개는 사람이 결정
    "sort": 1, "lowestPriceGuarantee": false, "sameDayBooking": true, "instantConfirm": true
  },
  "images": { "main": ["image-…"], "detail": ["image-…"] },
  "places": [
    { "key": "wat-mahathat", "name": "왓 마하탓", "nameEn": "Wat Mahathat", "cityLabel": "아유타야(AUB)",
      "address": "…", "description": "공개 사실 기반 소개", "keyword": "아유타야,사원", "images": ["image-…"] }
  ],
  "options": [ { "name": "[조인] 아유타야 선셋 투어", "description": "…", "basePax": 1, "maxPax": 30, "priceTypes": ["성인", "아동", "유아"] } ],
  "sales": [
    { "option": "[조인] 아유타야 선셋 투어", "from": "2026-10-15", "to": "2026-10-31", "status": "판매중", "stock": 99,
      "prices": [ { "type": "성인", "original": 47000, "sale": 39000 }, { "type": "아동", "original": 24800, "sale": 24800 }, { "type": "유아", "original": 0, "sale": 0 } ] }
  ],
  "reference": [
    { "title": "상품 소개", "elements": [ { "images": ["image-…"] }, { "text": [ { "text": "한 줄 카피", "emphasis": true }, "소개 문장" ] } ] },
    { "title": "투어 하이라이트", "elements": [ { "heading": "① …" }, { "images": ["image-…"] }, { "text": ["…"] } ] },
    { "title": "포함 / 불포함", "elements": [ { "heading": "포함사항" }, { "list": ["…"] }, { "heading": "불포함사항" }, { "list": ["…"] } ] }
  ],
  "schedule": [
    { "day": 1, "steps": [
      { "kind": "custom", "title": "14:30 미팅 장소 집결", "short": "아속역 로빈슨 1층", "description": "…" },
      { "kind": "place", "title": "15:30 아유타야 유적 탐방", "description": "입장료 안내 등", "places": ["wat-mahathat"] }
    ] }
  ],
  "terms": { "cancelRefund": [ { "text": "무료 취소 불가 상품입니다.", "emphasis": true }, "미팅 지각·미참여 시 노쇼로 환불되지 않습니다." ] }
}
```

- 가격은 **원문 가격 그대로**: `original`=정가(취소선), `sale`=판매가. 판매가가 낮으면 홈페이지에 할인으로 보인다. 원문에 없는 가격을 만들지 않는다.
- `sales`는 옵션마다 모든 가격구분을 포함하고 기간이 겹치지 않는다. 요일 선택은 매일(전체)만 지원한다.
- 문장(`text`/`list` 항목)에는 줄바꿈을 넣지 않는다(ERP 규칙). 강조는 `{text, emphasis:true}` → 빨간 굵은 글씨.
- 모든 `places`는 일정의 `kind:"place"` 단계에 연결해야 한다. 같은 도시·같은 이름의 회사 콘텐츠가 있으면 재사용하고 없을 때만 만든다.

## 판매 가능한 품질 기준 (사용자 피드백 반영)

- **소개와 관광지 설명은 한 줄로 줄이지 않는다.** `master.shortDescription`은 요약용이고 `master.description`, `places[].description`, 참조정보에는 원문의 구체적인 특징·볼거리·체험 흐름·이용 안내를 충분히 담는다. 내용이 있으면 3~6개 문단으로 정리하고 없는 정보로 분량을 채우지 않는다. 같은 문장 반복 대신 각 칸의 역할에 맞게 작성한다. `places[].description`은 기존 문자열 형식이며 콘텐츠 전용 `descriptionSections`를 FIT 초안에 넣지 않는다.
- 원문에 있는 소개·하이라이트·미팅/교통·포함/불포함·일정·준비물·이용조건·FAQ·취소규정을 한 번의 초안 작성에서 모두 확인한다. 없는 FAQ나 약속을 창작하지 않는다. 자료가 이름뿐인 장소만 관광청·시설 공식 텍스트를 묶어 확인해 근거를 보충한다. 사진 검색은 하지 않는다.
- **참조정보는 글만 나열하지 않는다.** 상품 소개 첫 요소는 대표 사진 + 한 줄 카피, "투어 하이라이트"는 소제목 → 사진 → 2~3줄 설명 반복, 미팅 장소 사진·복장 안내도 같은 실용 이미지는 해당 블록에 넣는다. 블록은 10개 안팎으로 묶는다(블록 제목이 홈페이지 상단 탭 메뉴가 된다). 이미지는 전체 폭으로 세로로 쌓이므로 한 소제목에 1~2장이 보기 좋다.
- **일정 사진은 관광지 콘텐츠 연결로 넣는다.** 관광지·크루즈 등은 `places`로 만들고 일정 `kind:"place"`로 연결하면 일정표에 사진·설명·상세보기가 나온다. 미팅·이동·자유시간만 `custom`.
- **대표 이미지**에는 미팅 장소·안내도 같은 실용 사진을 넣지 않는다. 대표와 상세 이미지는 겹치지 않게(갤러리에 합쳐져 두 번 보인다).
- 원문에 없는 약속(최저가보장 등)은 켜지 않는다. 포함/불포함, 준비물, 어린이 기준, 현장 추가요금, 복장 규정, 조인/단독 차이, 우천, 노쇼·취소 규정을 빠짐없이 옮긴다.
- 사진은 따로 찾아오지 않는다. 원문·사용자 자료에 사진이 있으면 넣고, 없으면 사진 없이 등록하고 "사진 없음"으로 보고한다(관광지 콘텐츠의 `images`도 생략 가능). 사진을 사원명에 확신 없이 짝짓지 말고, 불확실하면 보고한다.
