# 기존 콘텐츠 사진 덧붙이기

이미 저장된 회사 공용 콘텐츠(관광지 `place`·선택관광 `optionaltour`) 가운데 **사진이 하나도 없는 것**에 사진을 붙인다. 콘텐츠 등록(`product_content_*`)은 같은 콘텐츠를 재사용만 하고 고치지 않으므로, 사진을 나중에 넣을 때 이 흐름을 쓴다. 식당·쇼핑·미팅장소는 ERP 수정 화면을 아직 검증하지 않아 받지 않는다.

## 순서

1. `product_import_source`(seasonMode `excluded`)로 대상 콘텐츠 목록과 사용자 요청 원문을 기록한다.
2. 사진을 `product_import_images`로 모은다. 원문 사진이 있으면 그것을, 사용자가 예시 사진을 요청했으면 사용자가 허락한 출처(예: Wikimedia Commons의 CC0·퍼블릭 도메인 파일 원본)만 쓴다. `alt`에 무엇을 찍은 사진인지와 출처·라이선스를 적는다. 업체 로고가 박힌 광고 이미지, 그 장소인지 확신할 수 없는 사진은 넣지 않는다. 실제 가게(식당 등)를 다른 곳 사진으로 대신하지 않는다.
3. `product_content_photos_prepare({id, contentPhotos})`: 형식만 검사하고 저장한다. ERP는 건드리지 않는다.
4. `product_content_photos_review({id})`: 콘텐츠마다 수정 화면을 읽기만 하고, 저장된 이름·사용 상태·현재 사진 수를 확인해 사진을 붙일 대상과 이미 사진이 있어 건너뛸 대상을 요약한다. `planDigest`를 돌려준다.
5. 사용자가 등록을 지시했거나 맡겼으면 추가 질문 없이 `product_content_photos_register({id, companyId, accountName, planDigest, delegation:{explicitUserRequest:true, userInstruction:'직접 사용자의 원문'}})`. 즉시 `status='running'`을 반환하고 백그라운드로 실행한다.
6. `product_import_get({id, compact:true})`의 `.contentPhotos`에서 `stage`, `completedCount/count`로 진행을 보고, `status='completed'`이면 `results[]`(콘텐츠별 `status`: `added`/`skipped-has-photos`, 붙인 ERP 이미지 번호 `photos`)와 `added`, `skipped`를 보고한다.

## contentPhotos 형식

```json
{
  "contents": [
    { "type": "place", "contentId": "135511", "name": "빅토리아 피크", "images": ["image-c0668aa6dfb42534840b3b94"] },
    { "type": "optionaltour", "contentId": "14647", "name": "[예시] 마카오 타워 스카이워크", "images": ["image-937baf8a64cdecae2ae2d993"] }
  ]
}
```

- `type`: `place`(관광지) 또는 `optionaltour`(선택관광).
- `contentId`: ERP 콘텐츠 번호. `name`: ERP에 저장된 명칭(한글) 그대로. 번호와 이름이 다르면 검토에서 멈춘다.
- `images`: 이 작업에서 모은 이미지 ID 1~10개. 순서대로 붙고 첫 번째가 대표 이미지가 된다.
- 콘텐츠는 최대 50개, 같은 콘텐츠는 한 번만.

## 원칙

- 사진이 없는 콘텐츠에만 붙인다. 이미 사진이 있으면 기존 사진을 바꾸거나 뒤에 덧붙이지 않고 건너뛴다.
- 사진 외의 항목(이름·설명·지역·요금 등)은 수정 화면에서 읽은 값을 그대로 다시 보낸다. 저장 뒤 재조회에서 그 항목이 하나라도 바뀌었으면 실패로 보고한다.
- 수정 화면에 이 기능이 모르는 칸이 있으면 쓰기 전에 멈춘다.
- 회사 공용 콘텐츠라 붙인 사진은 그 콘텐츠를 쓰는 모든 상품에 보인다.

## 재실행·실패

- 검토 뒤 콘텐츠가 바뀌었으면(다른 항목 변경, 사진 추가) 저장하지 않고 다시 검토하게 한다.
- 이미 올린 사진은 장부의 바이트 지문으로 재사용하므로 다시 올리지 않는다.
- 저장이 거절되고 재조회도 그대로면 ERP는 바뀌지 않은 것이다. 원인을 고친 새 작업으로 다시 한다.
- 저장을 시도한 콘텐츠는 재조회에서 계획한 사진이 정확히 보일 때만 완료로 이어간다. 아니면 자동 재시도하지 않고 ERP 확인을 요청한다.
