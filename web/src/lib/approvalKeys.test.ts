import { describe, expect, it } from 'vitest';
import { resolveApprovalKey } from './approvalKeys';

describe('resolveApprovalKey', () => {
  it('answers with plain y/n when the page (not a field) has focus', () => {
    expect(resolveApprovalKey({ key: 'y', tagName: 'BODY' })).toBe('yes');
    expect(resolveApprovalKey({ key: 'Y', tagName: 'BUTTON' })).toBe('yes');
    expect(resolveApprovalKey({ key: 'n', tagName: 'BUTTON' })).toBe('no');
    expect(resolveApprovalKey({ key: 'N', tagName: 'BODY' })).toBe('no');
  });

  it('answers from the empty composer so y/n never lands in the draft', () => {
    expect(resolveApprovalKey({ key: 'y', tagName: 'TEXTAREA', value: '' })).toBe('yes');
    expect(resolveApprovalKey({ key: 'n', tagName: 'TEXTAREA', value: '' })).toBe('no');
  });

  it('leaves y/n alone once the composer holds a message', () => {
    expect(resolveApprovalKey({ key: 'y', tagName: 'TEXTAREA', value: 'hello' })).toBeNull();
    expect(resolveApprovalKey({ key: 'n', tagName: 'TEXTAREA', value: ' ' })).toBeNull();
  });

  it('never steals keys from other inputs', () => {
    expect(resolveApprovalKey({ key: 'y', tagName: 'INPUT', value: '' })).toBeNull();
  });

  it('declines on Escape away from fields only, leaving composer Escape to stop', () => {
    expect(resolveApprovalKey({ key: 'Escape', tagName: 'BODY' })).toBe('no');
    expect(resolveApprovalKey({ key: 'Escape', tagName: 'TEXTAREA', value: '' })).toBeNull();
    expect(resolveApprovalKey({ key: 'Escape', tagName: 'TEXTAREA', value: 'draft' })).toBeNull();
  });

  it('ignores modified, IME and unrelated keys', () => {
    expect(resolveApprovalKey({ key: 'y', tagName: 'BODY', metaKey: true })).toBeNull();
    expect(resolveApprovalKey({ key: 'n', tagName: 'BODY', ctrlKey: true })).toBeNull();
    expect(resolveApprovalKey({ key: 'y', tagName: 'BODY', altKey: true })).toBeNull();
    expect(resolveApprovalKey({ key: 'y', tagName: 'BODY', isComposing: true })).toBeNull();
    expect(resolveApprovalKey({ key: 'Enter', tagName: 'BODY' })).toBeNull();
    expect(resolveApprovalKey({ key: 'a', tagName: 'BODY' })).toBeNull();
  });
});
