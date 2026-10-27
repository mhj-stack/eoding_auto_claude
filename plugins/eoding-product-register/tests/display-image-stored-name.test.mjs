import assert from 'node:assert/strict';
import test from 'node:test';
import { storedImageName } from '../src/display-image.mjs';

const prefix = 'https://media.eoding.com/media/travelagent/361/imagecontent/';

test('stored image name keeps the suffix the ERP adds to a duplicate upload name', () => {
  assert.equal(storedImageName(prefix + 'image-698116565a0cbf4ddfa3be75.jpg'), 'image-698116565a0cbf4ddfa3be75.jpg');
  assert.equal(storedImageName(prefix + 'image-698116565a0cbf4ddfa3be75_Eq3X4Um.jpg'), 'image-698116565a0cbf4ddfa3be75_Eq3X4Um.jpg');
});

test('stored image name decodes the URL path and ignores query strings', () => {
  assert.equal(storedImageName(prefix + '%ED%99%8D%EC%BD%A9%20%EC%95%BC%EA%B2%BD.jpg?v=2'), '홍콩 야경.jpg');
});

test('stored image name rejects a source without a file name', () => {
  assert.throws(() => storedImageName(prefix), /no stored file name/);
});
