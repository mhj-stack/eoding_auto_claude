# 패키지 일정 콘텐츠 카드

저장된 패키지 일정표의 일차에 회사 공용 콘텐츠(관광지·식당·선택관광)를 카드로 연결한다. 패키지 일차 저장은 일차별 일정 문구·식사만 쓴다. 콘텐츠 카드는 그 뒤에 이 흐름으로 붙인다.

## 언제 쓰나

- 패키지 등록(`product_import_approve`)이 `completed`·`result.finalCheck='verified'`까지 끝난 같은 작업: `productId/scheduleId`를 생략하면 그 작업의 상품·일정표를 쓴다. 시즌·행사까지 요청했다면 그것도 끝난 뒤에 붙인다.
- 이미 저장된 패키지 상품의 일정표: `productId`와 `scheduleId`를 지정한다. 일정표 번호는 상품 일정 탭 목록의 일정표다(`/tour/master_product_schedule/<scheduleId>/detail/`).

## 순서

1. `product_day_contents_prepare({id, dayContents})`
2. `product_day_contents_review({id})`: 일정표 상세 JSON, 콘텐츠별 재사용·신규 생성, 이미 저장된 카드를 읽기만 하고 일차별 요약과 `planDigest`를 돌려준다.
3. 사용자가 등록을 지시했거나 맡겼으면 추가 질문 없이 `product_day_contents_register({id, companyId, accountName, planDigest, delegation:{explicitUserRequest:true, userInstruction:'직접 사용자의 원문'}})`. 백그라운드로 실행한다.
4. `product_import_get({id})`에서 받은 `revision`으로 `product_import_get({id,afterRevision:revision,waitMs:30000})`를 이어 호출한다. `unchanged:true`면 같은 변경 번호로 기다린다. `.dayContents`의 `stage`(`contents`, `day:N`, `final`)와 `completedDays/dayCount`로 진행을 알린다. `status='completed'`이면 `result.days[].cards[]`(카드 행 번호 `detailId`, 연결 콘텐츠 번호)를 보고한다.

## dayContents 형식

```json
{
  "productId": "65276", "scheduleId": "98832",
  "contents": [
    { "type": "place", "key": "gold-dredge", "name": "골드 드레지 8", "cityLabel": "페어뱅크스(FAI)", "description": "…" }
  ],
  "days": [
    { "day": 2, "cards": [
      { "type": "place", "title": "페어뱅크스 시내 관광", "contents": [ { "contentId": "134980" }, { "name": "치나 온천", "cityLabel": "페어뱅크스(FAI)" }, "gold-dredge" ] },
      { "type": "optionaltour", "contents": [ { "contentId": "14617" } ] }
    ] }
  ]
}
```

- `days[].cards[]`는 그 일차의 **마지막 단계 뒤에 순서대로 추가**된다. 기존 일정 행·식사·호텔·이미지는 바꾸지 않는다.
- `type`: `place`(관광지, 일정 유형 4) · `meal`(식당, 3) · `optionaltour`(선택관광, 8). 쇼핑·미팅장소는 일정 카드가 아니다(쇼핑센터는 상세 `content.detail.shopping`).
- `title?`(카드 제목, 비우면 ERP가 첫 콘텐츠 이름을 보여줌), `description?`(카드 메모) — HTML 없이.
- `contents[]` 참조 3가지(카드 type과 같은 종류여야 함):
  - `{ "contentId": "134980" }` — 기존 콘텐츠 번호. 검토에서 활성 상태와 이름을 확인한다.
  - `{ "name", "cityLabel" }` — 같은 종류·도시·이름의 활성 콘텐츠가 정확히 하나 있어야 한다.
  - `"key"` 또는 `{ "key" }` — `contents`에 정의한 항목. 같은 종류·도시·이름이 있으면 재사용, 없으면 콘텐츠 등록과 같은 방식으로 만든다(형식·사진·돈 칸 원칙은 [contents.md](contents.md)).
- `contents`에 정의한 항목은 반드시 어느 카드에서든 쓰여야 한다.

## 재실행·실패

- 계획한 카드가 이미 그대로 저장된 일차는 다시 쓰지 않고 그 행 번호를 결과로 쓴다. 일부만 있으면 멈추고 ERP 확인을 요청한다.
- 일차 저장 응답이 오류(4xx/5xx)이고 재조회에서 일정이 그대로면 원인을 고친 뒤 같은 검토로 다시 실행할 수 있다.
- 응답을 받지 못했고 재조회에도 카드가 없으면 결과가 불명확하므로 자동 재시도하지 않는다. 작업번호와 장부를 보존하고 ERP에서 확인한다.
