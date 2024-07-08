import { customAlphabet } from 'nanoid';

const alphabet = customAlphabet(
  '1234567890abcdefghijklmnopqrstuvxyzABCDEFGHIJKLMNOPQRSTUVXYZ',
);
export const generateId = () => alphabet(12);
