// The QoreChain SDK and cosmjs expect Node's Buffer. Imported first in main.tsx.
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (!g.Buffer) g.Buffer = Buffer;
