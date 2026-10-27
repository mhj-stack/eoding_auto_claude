import assert from 'node:assert/strict';
import test from 'node:test';
import { assertBadgeLength, BADGE_TOTAL_MAX } from '../src/display-image.mjs';

test('three badges may use at most 15 characters together, spaces included', () => {
  assert.equal(BADGE_TOTAL_MAX, 15);
  assert.equal(assertBadgeLength({ badge1: 'TOP PICK', badge2: '노쇼핑', badge3: '5성급' }), 14);
  assert.equal(assertBadgeLength({ badge1: 'TOP PICK', badge2: '노쇼핑', badge3: '5성급!' }), 15);
  assert.throws(() => assertBadgeLength({ badge1: 'TOP PICK', badge2: '노팁·노쇼핑', badge3: '5성급 호텔' }), /15자 이하.*지금 20자/);
});

test('missing or blank badges do not count and other display fields are ignored', () => {
  assert.equal(assertBadgeLength(undefined), 0);
  assert.equal(assertBadgeLength({ short_description: '아주 긴 소개 문구가 들어가도 뱃지 길이와는 무관합니다', badge2: '  ' }), 0);
});
