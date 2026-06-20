// vitest setupFile — installs the node-side UglyNative mock BEFORE any test
// module imports `ugly-app/native`. This matters because the native wrapper's
// `permissions` facade captures `platform` at import time and throws for 'web';
// installing a 'desktop' mock first makes fs/process permission checks pass.
import { installUglyNativeNodeMock } from './uglyNativeMock';

installUglyNativeNodeMock();
