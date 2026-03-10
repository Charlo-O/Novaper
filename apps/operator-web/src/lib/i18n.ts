import { en } from './locales/en.js';
import { zh } from './locales/zh.js';

export type Locale = 'en' | 'zh';

export type Translations = typeof en;

export const translations: Record<Locale, Translations> = {
  en,
  zh,
};

export const localeNames: Record<Locale, string> = {
  en: 'EN',
  zh: '中文',
};
