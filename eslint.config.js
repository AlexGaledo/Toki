// ESLint flat config. Every rule here exists because an agent (or a human) got something wrong once: each custom
// message names the fix, so the next one reads the answer instead of guessing. Today's violations are frozen in
// eslint-suppressions.json (ESLint bulk suppressions), so only NEW violations fail. See docs/DEVELOPMENT.md > Lint.
import { readFileSync } from 'node:fs';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import comments from '@eslint-community/eslint-plugin-eslint-comments';
import globals from 'globals';

const TS = ['**/*.{ts,tsx,mts,cts}'];
const TESTS = ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/test-fixtures/**'];

const LOG_ERROR = 'logError(prefix, err) from packages/hub/src/providers/redact.ts';
const CONFIRM = 'confirmAction() or <ConfirmDialog> from packages/web/src/components/ui.tsx';

/** Local rules: things core ESLint cannot say with a custom message. */
const local = {
  rules: {
    'no-empty-catch': {
      meta: {
        type: 'problem',
        docs: { description: 'Disallow a catch block with no statements and no comment' },
        messages: {
          empty: 'Empty catch: handle or log the error; an empty catch hides failures. If ignoring it is really right, say why in a comment inside the block.',
        },
        schema: [],
      },
      create(context) {
        return {
          CatchClause(node) {
            const body = node.body;
            if (body.body.length === 0 && context.sourceCode.getCommentsInside(body).length === 0) {
              context.report({ node: body, messageId: 'empty' });
            }
          },
        };
      },
    },
  },
};

// Radix: only the primitives the web app already depends on. A new one is a design-system decision, not a drive-by.
const webPkg = JSON.parse(readFileSync(new URL('./packages/web/package.json', import.meta.url), 'utf8'));
const radixAllowed = Object.keys(webPkg.dependencies ?? {})
  .filter((n) => n.startsWith('@radix-ui/'))
  .map((n) => n.slice('@radix-ui/'.length));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const HUB_BOUNDARY = {
  regex: '^(?:@pocketrocket/hub(?:/.*)?|(?:\\.\\./)+(?:packages/)?hub(?:/.*)?)$',
  message: 'web and shared must not import the hub (it is a separate Node process). Put the type or schema in packages/shared and import it from @pocketrocket/shared.',
};
const WEB_BOUNDARY = {
  regex: '^(?:@pocketrocket/web(?:/.*)?|(?:\\.\\./)+(?:packages/)?web(?:/.*)?)$',
  message: 'shared must not import web: shared is the contract both sides depend on. Move the code into packages/shared, or keep it in web.',
};
const RADIX_ONLY_KNOWN = {
  // react-icons is left to ICONS_LUCIDE_ONLY, which gives the better message.
  regex: `^@radix-ui/(?!(?:${[...radixAllowed, 'react-icons'].map(esc).join('|')})(?:/|$)).+`,
  message: `Only these Radix packages are in use: ${radixAllowed.map((n) => '@radix-ui/' + n).join(', ')}. Use the wrapper in packages/web/src/components/ui.tsx; adding a new Radix primitive is a design-system change (pr-design-system).`,
};
const ICONS_LUCIDE_ONLY = {
  group: ['react-icons', 'react-icons/*', '@heroicons/*', '@fortawesome/*', '@tabler/icons-react', '@tabler/icons', '@phosphor-icons/*', 'phosphor-react', '@mui/icons-material', '@mui/icons-material/*', 'react-feather', '@iconify/react', '@radix-ui/react-icons'],
  message: 'Icons come from lucide-react only, so every icon shares one stroke and size.',
};

export default [
  {
    ignores: [
      '**/node_modules/**', '**/dist/**', '**/build/**', '**/coverage/**',
      'packages/desktop/**', 'packages/site/**', 'deploy/**', 'supabase/**', 'scripts/**', 'patches/**',
      '**/*.d.ts', '**/vite.config.ts', '**/vitest.config.ts',
    ],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error', reportUnusedInlineConfigs: 'error' },
  },
  { files: TS, ...js.configs.recommended },
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: TS })),
  {
    files: TS,
    plugins: { '@eslint-community/eslint-comments': comments, local },
    rules: {
      // An inline disable must say why: `// eslint-disable-next-line rule -- reason`.
      '@eslint-community/eslint-comments/require-description': 'error',
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }], // empty catch is local/no-empty-catch, with a message
      'local/no-empty-catch': 'error',
    },
  },

  // hub: Node, and every caught error goes through the redactor.
  {
    files: ['packages/hub/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['packages/hub/src/**/*.{ts,tsx}'],
    ignores: [...TESTS, 'packages/hub/src/providers/redact.ts'], // redact.ts is logError itself
    rules: {
      'no-restricted-properties': ['error', {
        object: 'console',
        property: 'error',
        message: `Use ${LOG_ERROR} (redacts secrets): a caught error can carry a token-bearing URL, header or body.`,
      }],
    },
  },

  // web: browser + React.
  {
    files: ['packages/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: Object.fromEntries(
      // All hook rules are errors so they ratchet: bulk suppressions only freeze errors.
      Object.keys(reactHooks.configs.flat.recommended.rules).map((r) => [r, 'error']),
    ),
  },
  {
    files: ['packages/web/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': ['error',
        { name: 'confirm', message: `Use ${CONFIRM}: the browser dialog blocks the app and looks foreign in the desktop window.` },
        { name: 'alert', message: 'Use a <Banner> or <Dialog> from packages/web/src/components/ui.tsx, not the browser alert().' },
        { name: 'prompt', message: 'Use a <Dialog> with an <Input> from packages/web/src/components/ui.tsx, not the browser prompt().' },
      ],
      'no-restricted-properties': ['error',
        { object: 'window', property: 'confirm', message: `Use ${CONFIRM}, not window.confirm.` },
        { object: 'window', property: 'alert', message: 'Use a <Banner> or <Dialog> from packages/web/src/components/ui.tsx, not window.alert.' },
        { object: 'window', property: 'prompt', message: 'Use a <Dialog> with an <Input> from packages/web/src/components/ui.tsx, not window.prompt.' },
      ],
      'no-restricted-imports': ['error', {
        patterns: [HUB_BOUNDARY, RADIX_ONLY_KNOWN, ICONS_LUCIDE_ONLY],
      }],
    },
  },
  {
    files: ['packages/web/src/**/*.{ts,tsx}'],
    ignores: TESTS,
    rules: {
      'no-restricted-syntax': ['error', ...[
        "CallExpression[callee.name='setTimeout']",
        "CallExpression[callee.type='MemberExpression'][callee.object.name=/^(window|globalThis|self)$/][callee.property.name='setTimeout']",
      ].map((selector) => ({
        selector,
        message: 'setTimeout: timers usually patch over a state/architecture problem (a race, a missing event, a layout wait); fix the cause, or suppress with a reason: `// eslint-disable-next-line no-restricted-syntax -- why a timer is right here`.',
      }))],
    },
  },

  // shared: the contract between hub and web. Imports neither.
  {
    files: ['packages/shared/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [HUB_BOUNDARY, WEB_BOUNDARY] }],
    },
  },
];
