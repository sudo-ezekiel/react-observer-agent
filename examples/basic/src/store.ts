import { create } from 'zustand';

interface Product {
  id: string;
  name: string;
  price: number;
}

interface CartItem {
  product: Product;
  quantity: number;
}

interface AppState {
  user: { name: string; email: string };
  currentPage: string;
  cart: CartItem[];
  products: Product[];
  navigateTo: (page: string) => void;
  addToCart: (productId: string) => void;
  clearCart: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  user: { name: 'Alice', email: 'alice@example.com' },
  currentPage: 'home',
  cart: [],
  products: [
    { id: 'p1', name: 'Wireless Headphones', price: 59.99 },
    { id: 'p2', name: 'Mechanical Keyboard', price: 129.99 },
    { id: 'p3', name: 'USB-C Hub', price: 39.99 },
  ],
  navigateTo: (page) => set({ currentPage: page }),
  addToCart: (productId) => {
    const product = get().products.find((p) => p.id === productId);
    if (!product) return;
    const existing = get().cart.find((c) => c.product.id === productId);
    if (existing) {
      set({
        cart: get().cart.map((c) =>
          c.product.id === productId ? { ...c, quantity: c.quantity + 1 } : c,
        ),
      });
    } else {
      set({ cart: [...get().cart, { product, quantity: 1 }] });
    }
  },
  clearCart: () => set({ cart: [] }),
}));
