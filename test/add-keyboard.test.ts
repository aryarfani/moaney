import { describe, expect, it } from 'vitest';

// The page belongs to the browser TS project; Vitest loads its TSX directly.
const pageModule = '../web/src/pages/Add.tsx';
const { typedEntryAction } = await import(pageModule);

const enter = { key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false, isComposing: false };
const entry = { raw: 'sayur 29k', description: 'Sayur', type: 'expense', amount: 2_900_000, walletId: 1, categoryId: 2, toWalletId: null, problems: [] };

describe('typed entry keyboard shortcut', () => {
  it('reads text before preview and saves valid entries after preview', () => {
    expect(typedEntryAction(enter, 'sayur 29k', [], false)).toBe('read');
    expect(typedEntryAction(enter, 'sayur 29k', [entry], false)).toBe('save');
  });

  it('does not submit blank text, busy operations, or invalid entries', () => {
    expect(typedEntryAction(enter, '  ', [], false)).toBeNull();
    expect(typedEntryAction(enter, 'sayur 29k', [], true)).toBeNull();
    expect(typedEntryAction(enter, 'sayur 29k', [entry], true)).toBeNull();
    for (const patch of [{ amount: null }, { walletId: null }, { categoryId: null }, { problems: ['Missing amount'] }, { type: 'transfer' as const, toWalletId: null }]) {
      expect(typedEntryAction(enter, 'sayur 29k', [{ ...entry, ...patch }], false)).toBeNull();
    }
    expect(typedEntryAction(enter, 'transfer 29k', [{ ...entry, type: 'transfer', categoryId: null, toWalletId: 3 }], false)).toBe('save');
  });

  it('preserves newlines, modified keys, composition, and held Enter', () => {
    for (const patch of [{ key: 'a' }, { shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }]) {
      expect(typedEntryAction({ ...enter, ...patch }, 'sayur 29k', [entry], false)).toBeNull();
    }
  });
});
