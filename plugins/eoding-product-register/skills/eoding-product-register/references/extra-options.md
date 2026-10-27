# 상품 추가옵션

상품 상세의 **추가옵션** 탭(`/tour/master_product/sub_option/<상품ID>/`)에 옵션과 가격 항목을 덧붙인다. 일정 카드의 선택관광(`product_day_contents_*`의 `optionaltour`)과는 다른 기능이다. 행사(`/tour/product/sub_option/<행사ID>/`)도 같은 탭을 따로 가지므로 대상이 별도다.

## 언제 쓰나

- 패키지 등록(`product_import_approve`)이 `completed`·`result.finalCheck='verified'`까지 끝난 같은 작업: `productId`·`eventIds`를 생략하면 그 상품과 그 작업이 만든 행사에 함께 넣는다.
- 이미 저장된 상품: `productId`를 지정한다. 행사에도 넣을 때만 `eventIds`를 준다(`[]`이면 상품만).

## 순서

1. `product_extra_options_prepare({id, extraOptions})`: 형식만 검사하고 저장한다. ERP는 건드리지 않는다.
2. `product_extra_options_review({id})`: 대상마다 추가옵션 탭을 읽기만 하고 새로 덧붙일 옵션, 같은 내용으로 이미 있는 옵션, 같은 이름이 다른 내용으로 있어 건너뛸 옵션을 요약한다. `planDigest`를 돌려준다.
3. 사용자가 등록을 지시했거나 맡겼으면 추가 질문 없이 `product_extra_options_register({id, companyId, accountName, planDigest, delegation:{explicitUserRequest:true, userInstruction:'직접 사용자의 원문'}})`. 대상마다 저장 1번과 독립 재조회로 끝나며 결과를 바로 돌려준다.
4. `product_import_get({id})`의 `.extraOptions`에서 `status`, 대상별 `created`(새 옵션 번호)와 `skipped`를 확인한다.

## extraOptions 형식

```json
{
  "productId": "65661",
  "eventIds": ["10968674"],
  "options": [
    {
      "name": "객실 업그레이드",
      "selection": "single",
      "required": false,
      "items": [
        { "name": "싱글룸 사용", "price": 260000, "description": "1인 1실" },
        { "name": "디럭스룸 업그레이드", "price": 80000 }
      ]
    },
    {
      "name": "추가 서비스",
      "selection": "multiple",
      "items": [ { "name": "공항 라운지", "price": 55000, "countable": true } ]
    }
  ]
}
```

- `name`: 추가옵션명(필수, 100자 이하). 같은 작업 안에서 겹치면 안 된다.
- `selection`: 항목선택방식(홈페이지). `single`=단일선택(기본), `multiple`=다중선택.
- `required`: 필수여부(홈페이지). `false`=선택구매(기본), `true`=필수구매.
- `items[]`: 1~50개. `name`(항목명, 필수), `price`(판매가, 0 이상 정수 원), `description?`(설명, 200자 이하), `countable?`(수량사용, 기본 false).
- 옵션은 최대 30개. HTML·앞뒤 공백은 받지 않는다.

## 원칙

- 기존 추가옵션은 그대로 다시 보내고 새 옵션만 맨 뒤에 덧붙인다. 기존 옵션을 고치거나 지우지 않는다.
- 같은 이름이 같은 내용으로 이미 있으면 만들지 않는다. 이름은 같은데 내용이 다르면 건너뛰고 검토 요약에 알린다.
- 원문에 없는 요금·조건을 지어내지 않는다. 사용자가 예시용 가상 옵션을 요청한 경우에만 이름에 `[예시]`를 붙여 만든다.

## 재실행·실패

- 검토 뒤 ERP의 추가옵션이 바뀌었으면 저장하지 않고 다시 검토하게 한다.
- 저장이 거절되고 재조회도 그대로면 ERP는 바뀌지 않은 것이다. 원인을 고친 새 작업으로 다시 한다.
- 저장을 시도한 대상은 재조회에서 계획한 결과가 정확히 보일 때만 완료로 이어간다. 아니면 자동 재시도하지 않고 ERP 확인을 요청한다.
