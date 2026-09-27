import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from './add.js';
test('adds two numbers', () => assert.equal(add(2, 2), 4));
