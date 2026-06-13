import type { PropsWithChildren } from 'react';

import { Providers } from '@/components/providers';
import './globals.css';

export const metadata = {
  title: 'SCIReader',
  description: 'AI-assisted scientific paper reader',
};

const RootLayout = ({ children }: PropsWithChildren) => {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
};

export default RootLayout;
