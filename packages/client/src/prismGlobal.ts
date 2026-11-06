import { Prism } from "prism-react-renderer";

// prismjs language files register themselves on a global `Prism`: point it at the copy
// prism-react-renderer bundles. Imported before them (see highlight.ts).
(globalThis as { Prism?: unknown }).Prism = Prism;
