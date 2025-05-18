import { registerTool } from 'react-observer-agent';
import { useAppStore } from './store';

export const navigateTo = registerTool(
  'navigateTo',
  async (args: { page: string }) => {
    useAppStore.getState().navigateTo(args.page);
    return `Navigated to ${args.page}`;
  },
  {
    description: 'Navigate to a different page in the app',
    parameters: {
      type: 'object',
      properties: {
        page: {
          type: 'string',
          enum: ['home', 'products', 'cart', 'profile'],
          description: 'The page to navigate to',
        },
      },
      required: ['page'],
    },
  },
);

export const addToCart = registerTool(
  'addToCart',
  async (args: { productId: string }) => {
    useAppStore.getState().addToCart(args.productId);
    const product = useAppStore.getState().products.find((p) => p.id === args.productId);
    return product ? `Added "${product.name}" to cart` : `Product ${args.productId} not found`;
  },
  {
    description: 'Add a product to the shopping cart by product ID',
    parameters: {
      type: 'object',
      properties: {
        productId: {
          type: 'string',
          description: 'The ID of the product to add (e.g. "p1", "p2", "p3")',
        },
      },
      required: ['productId'],
    },
  },
);

export const clearCart = registerTool(
  'clearCart',
  async () => {
    useAppStore.getState().clearCart();
    return 'Cart cleared';
  },
  {
    description: 'Remove all items from the shopping cart',
    confirm: true,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
);

export const tools = [navigateTo, addToCart, clearCart];
