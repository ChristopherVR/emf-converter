import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import LiveDemo from './components/LiveDemo.vue';

export default {
	extends: DefaultTheme,
	enhanceApp({ app }) {
		app.component('LiveDemo', LiveDemo);
	},
} satisfies Theme;
