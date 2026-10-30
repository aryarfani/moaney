import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { formatCompact, formatMoney } from '../../shared/money';
import { api, ApiError, setCsrf, type Category, type Wallet } from './api';

interface Store {
  wallets: Wallet[];
  categories: Category[];
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
  money: (minor: number) => string;
  compact: (minor: number) => string;
  wallet: (id: number | null) => Wallet | undefined;
  category: (id: number | null) => Category | undefined;
}

const Ctx = createContext<Store | null>(null);
export const useStore = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error('Store missing');
  return s;
};

export function StoreProvider({ children, onSignedOut }: { children: ReactNode; onSignedOut: () => void }) {
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);

  const reload = useCallback(async () => {
    try {
      const [w, c] = await Promise.all([api.wallets(), api.categories()]);
      setWallets(w);
      setCategories(c);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onSignedOut();
    }
  }, [onSignedOut]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const value: Store = {
    wallets,
    categories,
    reload,
    signOut: async () => {
      await api.logout().catch(() => undefined);
      setCsrf('');
      onSignedOut();
    },
    money: (n) => formatMoney(n, 'en'),
    compact: (n) => formatCompact(n, 'en'),
    wallet: (id) => wallets.find((w) => w.id === id),
    category: (id) => categories.find((c) => c.id === id),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
