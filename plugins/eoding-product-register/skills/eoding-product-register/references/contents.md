# ERP 콘텐츠 등록 형식

관광지·식당·쇼핑·선택관광·미팅장소 콘텐츠는 회사 공용이다. 상품 일정·상세에서 끌어와 연결하므로 한 번 만들면 다른 상품에서도 재사용된다.

## 순서

1. `product_import_source`(seasonMode `excluded`)로 근거 자료(상품 링크, 엑셀, 사용자가 준 목록·텍스트)를 기록한다.
2. **사진은 찾아오지 않는다.** 원문·사용자 자료에 그 콘텐츠의 사진이 있으면 `product_import_images`로 모아 `images`에 넣고, 없으면 `images`를 생략한다. 업체 로고가 박힌 광고 이미지는 넣지 않는다. 사진을 이름에 확신 없이 짝짓지 않는다.
3. `product_import_lookups`로 도시 표시명(예: `아유타야(AUB)`)을 확인한다.
4. `product_content_prepare({id, contents})` → `product_content_review({id})`로 기존 재사용/신규 생성과 사진 유무 요약을 사용자에게 보여준다.
5. 사용자가 같은 범위의 등록을 지시했거나 맡겼으면 추가 승인 질문 없이 `product_content_register({id, companyId, accountName, planDigest, delegation:{explicitUserRequest:true, userInstruction:'직접 사용자의 원문'}})`. 즉시 `status='running'`을 반환하고 백그라운드로 실행한다.
6. `product_import_get({id})`에서 받은 `revision`으로 `product_import_get({id,afterRevision:revision,waitMs:30000})`를 이어 호출한다. `unchanged:true`면 같은 변경 번호로 기다린다. `.contents`의 `stage`, `completedCount`, `count`로 진행을 확인하고 `status='completed'`의 `results/created/reused/withoutPhotos/durationMs`를 보고한다. 실패·중단 후 같은 호출은 장부와 현재 검색 결과를 먼저 대조한다. 저장 시도한 항목이 재조회되지 않거나 기존 번호가 다르면 자동 재생성을 차단한다. 결과가 불명확한 쓰기는 새 작업으로 우회하지 않는다.

## contents 항목

공통: `type`, `key`(영문 소문자·숫자·하이픈), `name`(한글명), `nameEn?`, `cityLabel`, `description?`, `descriptionSections?`, `keyword?`, `images?`.

`description` 또는 `descriptionSections:[{title?,text}]` 중 본문 하나는 필요하다. 섹션은 최대 30개, 제목은 최대 100자이며 합친 본문의 클라이언트 상한은 12,000자다. ERP 서버의 모든 화면에서 이 길이를 지원한다는 보장은 아니다. 두 필드를 모두 주면 소개 뒤에 섹션을 빈 줄로 연결하므로 같은 문장을 반복하지 않는다. 저장할 때는 합친 `description` 하나로 정규화하고 자동으로 자르지 않는다.

| type | 추가 항목 | 비고 |
|---|---|---|
| `place` 관광지 | `address?` | |
| `meal` 식당 | — | |
| `shopping` 쇼핑 | `time`(예: 약 40분), `items`(품목), `refund`(`possible`/`impossible`), `refundTerm?` | 환불 여부는 원문 근거로만 |
| `optionaltour` 선택관광 | `currency`(USD, THB 등), `adultPrice`(숫자), `payment`(현장결제/여행사결제/상품가포함), `guide`(true/false), `duration`(소요시간), `alternative`(미참여 시 대체일정), `address?` | 요금·결제·가이드 동행은 원문 근거로만 |
| `meeting` 미팅장소 | `departport`(인천/서울, 김포, 부산, 대구, 청주, 광주, 제주, 양양, 부산항, 동해항, 인천항, 기타, 무안) | |

```json
[
  {
    "type": "place", "key": "source-place", "name": "원문의 관광지명", "cityLabel": "ERP에서 조회한 도시 표시명",
    "descriptionSections": [
      { "title": "소개", "text": "원문에서 확인한 위치와 장소의 성격을 충분히 설명한다." },
      { "title": "주요 볼거리", "text": "원문에 나온 볼거리와 특징을 빠뜨리지 않고 정리한다." },
      { "title": "관람 안내", "text": "원문에서 확인한 관람 방법과 주의사항만 넣는다." }
    ]
  }
]
```

## 원칙

- **소개글**: 원문에서 확인한 위치·소개, 주요 볼거리·특징, 방문/이용 방법, 접근·미팅 정보, 주의사항을 가능한 만큼 보존한다. 관광지는 볼거리, 식당은 음식·메뉴·이용환경, 쇼핑은 품목·이용조건, 선택관광은 체험 흐름·포함/미포함·대체일정, 미팅장소는 찾아가는 방법·확인 가능한 표지를 우선한다. 없는 항목은 빈 제목이나 “미정”으로 채우지 않는다.
- 원문이 충분하면 3~6개 문단이나 소제목으로 읽기 쉽게 구성한다. 길이 목표를 맞추기 위한 반복·홍보 문구는 넣지 않으며 구체적 사실·고유명사·조건을 짧은 문구로 축약해 버리지 않는다.
- 원문이 이름뿐이거나 소개가 없으면 부족한 대상의 관광청·시설 공식 페이지를 묶어 확인하고 추가 근거 URL을 명시한다. `product_import_source_supplement`는 같은 원문 URL의 보이는 내용만 받으므로 다른 출처를 기존 원문인 것처럼 제출하지 않는다. 자료가 확보되지 않으면 확인된 내용만 등록하고 정보 부족을 알린다. 설명 분량을 이유로 사용자에게 소개글 작성이나 추가 승인을 요구하지 않는다.
- 사진은 기존의 원문 사진만 사용한다. 설명을 보충하는 텍스트 조회가 사진 검색 허가는 아니다. 요금·영업시간·연령/신장 제한·포함 서비스 등 변동 정보는 명시적인 출처가 있을 때만 넣는다.
- 짧은 설명에 대한 품질 신호는 비차단 안내다. 원문 자체가 짧은 경우 근거 없는 내용으로 보충하거나 최소 글자 수를 강제하지 않는다.
- **돈·약속 칸**(선택관광 요금·결제방법·가이드 동행, 쇼핑 환불·시간·품목): 원문에 없으면 지어내지 않는다. 해당 항목을 등록 대상에서 빼고 "확인 필요"로 사용자에게 묻는다.
- 같은 종류·도시·이름의 활성 콘텐츠가 이미 있으면 새로 만들지 않고 재사용한다(기존 내용은 수정하지 않는다). 같은 이름이 여러 개면 ERP에서 정리하도록 알린다.
- 호텔·크루즈(Stay 화면)와 인솔자(개인정보)는 이 기능의 범위가 아니다.
