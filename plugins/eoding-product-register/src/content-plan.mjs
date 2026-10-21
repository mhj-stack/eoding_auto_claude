// ERP contents (콘텐츠): company-shared records that products link from schedules and details.
// One shared engine with a per-type field definition. Photos are never searched for: only images
// collected from the source job are attached, and a content without photos is still registered.

const fail = message => { throw new Error(message); };
const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
// Local input bound, not a claim about the ERP server's maximum. Saved text is read back in full.
export const CONTENT_DESCRIPTION_LIMIT = 12000;

export const CONTENT_CURRENCIES = Object.freeze(['KRW', 'USD', 'EUR', 'CNY', 'JPY', 'CHF', 'RUB', 'NZD', 'CAD', 'AUD', 'PHP', 'SGD', 'AED', 'SAR', 'QAR', 'VND', 'THB', 'IDR', 'MYR', 'TWD', 'HKD', 'GBP', 'ZAR', 'NOK', 'DKK', 'MXN', 'MNT', 'BHD', 'BDT', 'BRL', 'BND', 'LKR', 'SEK', 'DZD', 'OMR', 'JOD', 'ILS', 'EGP', 'INR', 'CZK', 'CLP', 'KZT', 'KES', 'COP', 'KWD', 'TZS', 'TRY', 'PKR', 'PLN', 'HUF', 'NPR', 'MOP', 'KHR', 'FJD', 'LYD', 'RON', 'MMK', 'ETB', 'UZS']);
const PAYMENT = Object.freeze({ 현장결제: '1', 여행사결제: '2', 상품가포함: '3' });
const REFUND = Object.freeze({ possible: '1', impossible: '2' });
export const DEPARTPORTS = Object.freeze({ '인천/서울': '1', 김포: '2', 부산: '3', 대구: '4', 청주: '5', 광주: '6', 제주: '7', 양양: '8', 부산항: '9', 동해항: '10', 인천항: '11', 기타: '12', 무안: '13' });

const text = (value, where, max, { optional = false, multiline = false } = {}) => {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) fail(`${where}는 앞뒤 공백 없는 1~${max}자 문자열이어야 합니다.`);
  if (!multiline && /[\r\n]/.test(value)) fail(`${where}에는 줄바꿈을 넣지 마세요.`);
  return value;
};

/** Keep source paragraphs intact; sections are an authoring convenience, not duplicated storage. */
function descriptionText(item, where) {
  const introduction = text(item.description, where + '.description', CONTENT_DESCRIPTION_LIMIT, { optional: true, multiline: true });
  const sections = item.descriptionSections;
  if (sections !== undefined && (!Array.isArray(sections) || sections.length < 1 || sections.length > 30)) fail(`${where}.descriptionSections는 1~30개 배열이어야 합니다.`);
  const blocks = sections === undefined ? [] : sections.map((section, index) => {
    const at = `${where}.descriptionSections[${index}]`;
    if (!section || typeof section !== 'object' || Array.isArray(section) || Object.keys(section).some(key => !['title', 'text'].includes(key))) fail(`${at}는 {title?, text} 객체여야 합니다.`);
    const title = text(section.title, at + '.title', 100, { optional: true });
    const body = text(section.text, at + '.text', CONTENT_DESCRIPTION_LIMIT, { multiline: true });
    return { body, rendered: title ? `${title}\n${body}` : body };
  });
  // If the introductory text is also supplied as a section, keep the section's heading once.
  const merged = [...(introduction && !blocks.some(block => block.body === introduction) ? [introduction] : []), ...blocks.map(block => block.rendered)];
  return text([...new Set(merged)].join('\n\n'), where + '.description', CONTENT_DESCRIPTION_LIMIT, { multiline: true });
}

/**
 * Per-type definition: ERP path, the extra keys an item may carry, how they validate, and the
 * exact native form fields. Money/promise fields (prices, payment, refund) must come from the
 * source — the AI never invents them; descriptions may be written from public facts.
 */
export const CONTENT_TYPES = Object.freeze({
  place: {
    label: '관광지', path: 'place', extra: ['address'],
    check: (item, where) => ({ address: text(item.address, where + '.address', 200, { optional: true }) }),
    fields: item => ({ spotpoi_id: '', geo_lat: '', geo_lng: '', spotpoi_name_ko: '', address: item.address, location: '', homepage: '' })
  },
  meal: {
    label: '식당', path: 'meal', extra: [],
    check: () => ({}), fields: () => ({})
  },
  shopping: {
    label: '쇼핑', path: 'shopping', extra: ['time', 'items', 'refund', 'refundTerm'],
    check: (item, where) => {
      if (!Object.hasOwn(REFUND, item.refund)) fail(`${where}.refund는 possible 또는 impossible입니다(원문 근거 필요).`);
      return { time: text(item.time, where + '.time', 100), items: text(item.items, where + '.items', 200), refund: item.refund, refundTerm: text(item.refundTerm, where + '.refundTerm', 1000, { optional: true, multiline: true }) };
    },
    fields: item => ({ shopping_time: item.time, shopping_item: item.items, refund_flag: REFUND[item.refund], refund_term: item.refundTerm, homepage: '' })
  },
  optionaltour: {
    label: '선택관광', path: 'optionaltour', extra: ['address', 'currency', 'adultPrice', 'payment', 'guide', 'duration', 'alternative'],
    check: (item, where) => {
      if (!CONTENT_CURRENCIES.includes(item.currency)) fail(`${where}.currency는 ERP 통화 코드(예: USD, THB)여야 합니다.`);
      if (typeof item.adultPrice !== 'number' || !Number.isFinite(item.adultPrice) || item.adultPrice < 0 || item.adultPrice > 100000000) fail(`${where}.adultPrice는 원문에 있는 성인 요금 숫자여야 합니다.`);
      if (!Object.hasOwn(PAYMENT, item.payment)) fail(`${where}.payment는 ${Object.keys(PAYMENT).join('/')} 중 하나입니다.`);
      if (typeof item.guide !== 'boolean') fail(`${where}.guide(가이드 동행)는 true/false입니다.`);
      return { address: text(item.address, where + '.address', 200, { optional: true }), currency: item.currency, adultPrice: item.adultPrice, payment: item.payment, guide: item.guide, duration: text(item.duration, where + '.duration', 100), alternative: text(item.alternative, where + '.alternative', 500) };
    },
    fields: item => ({ geo_lat: '', geo_lng: '', address: item.address, location: '', currency_code: String(CONTENT_CURRENCIES.indexOf(item.currency) + 1), adult_price: String(item.adultPrice), payment: PAYMENT[item.payment], accompany_guide_flag: item.guide ? 'True' : 'False', travel_time: item.duration, homepage: '', alternative_schedule: item.alternative })
  },
  meeting: {
    label: '미팅장소', path: 'meeting', extra: ['departport'],
    check: (item, where) => {
      if (!Object.hasOwn(DEPARTPORTS, item.departport)) fail(`${where}.departport는 ${Object.keys(DEPARTPORTS).join('/')} 중 하나입니다.`);
      return { departport: item.departport };
    },
    fields: item => ({ departport: DEPARTPORTS[item.departport] })
  }
});

/** Validates a batch of contents against the job's collected images; returns normalized items. */
export function validateContentPlan(contents, { imageIds = new Set() } = {}) {
  if (!Array.isArray(contents) || contents.length < 1 || contents.length > 50) fail('contents는 1~50개 배열이어야 합니다.');
  const items = contents.map((item, index) => {
    const where = `contents[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`${where}는 객체여야 합니다.`);
    const type = CONTENT_TYPES[item.type] ?? fail(`${where}.type은 ${Object.keys(CONTENT_TYPES).join('/')} 중 하나입니다.`);
    const allowed = ['type', 'key', 'name', 'nameEn', 'cityLabel', 'description', 'descriptionSections', 'keyword', 'images', ...type.extra];
    const extra = Object.keys(item).filter(key => !allowed.includes(key));
    if (extra.length) fail(`${where}(${type.label})에 지원하지 않는 항목이 있습니다: ${extra.join(', ')}`);
    if (typeof item.key !== 'string' || !KEY.test(item.key)) fail(`${where}.key는 영문 소문자·숫자·하이픈 1~40자입니다.`);
    const images = item.images === undefined ? [] : item.images;
    if (!Array.isArray(images) || images.length > 10 || new Set(images).size !== images.length) fail(`${where}.images는 중복 없는 0~10개 이미지 ID입니다.`);
    for (const id of images) if (!imageIds.has(id)) fail(`${where}.images의 ${id}는 이 작업에서 수집한 이미지 ID가 아닙니다.`);
    return {
      type: item.type, key: item.key, name: text(item.name, where + '.name', 100), nameEn: text(item.nameEn, where + '.nameEn', 100, { optional: true }),
      cityLabel: text(item.cityLabel, where + '.cityLabel', 60), description: descriptionText(item, where),
      keyword: text(item.keyword, where + '.keyword', 200, { optional: true }), images: [...images], ...type.check(item, where)
    };
  });
  if (new Set(items.map(item => item.key)).size !== items.length) fail('contents.key가 중복됩니다.');
  if (new Set(items.map(item => `${item.type}\u0000${item.cityLabel}\u0000${item.name}`)).size !== items.length) fail('같은 종류·도시·이름의 콘텐츠가 중복됩니다.');
  return items;
}

/** Exact multipart fields of the native content add form for one item. */
export function contentFields(item, region, erpImageIds) {
  return {
    image_sort: JSON.stringify({ old: [], new: erpImageIds.map((name, value) => ({ name, value })) }),
    name_ko: item.name, name: item.nameEn, continent: region.continentId, country: region.countryId, city: region.cityId,
    use_flag: 'True', not_use_reason: '', description: item.description, keyword: item.keyword,
    ...CONTENT_TYPES[item.type].fields(item)
  };
}

export function contentSummary(items, existing) {
  return items.map(item => `${CONTENT_TYPES[item.type].label} · ${item.name} (${item.cityLabel}) — ${existing[item.key] ? '기존 재사용 ' + existing[item.key] : '신규 생성'}, 사진 ${item.images.length ? item.images.length + '장' : '없음'}, 입력 설명 ${item.description.length}자${existing[item.key] ? ' (기존 내용 유지)' : ''}`);
}

/** Advisory only: a short authoritative source is valid and never triggers invented filler. */
export function contentQuality(items) {
  return {
    descriptionCharacters: items.reduce((total, item) => total + item.description.length, 0),
    shortDescriptions: items.filter(item => item.description.length < 80).map(item => ({ key: item.key, name: item.name, characters: item.description.length }))
  };
}
