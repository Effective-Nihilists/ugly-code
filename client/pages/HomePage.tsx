import React from 'react';
import { Card, PageLayout, Text } from 'ugly-app/client';

// This is your app's home page. Replace the body below with the UI for
// whatever you're building. The `''` route in shared/pages.ts maps here.
export default function HomePage(): React.ReactElement {
  return (
    <PageLayout>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
        <Card>
          <Text size="xl" weight="bold">Welcome</Text>
          <Text style={{ marginTop: 8 }}>
            This is the home page. Edit <code>client/pages/HomePage.tsx</code>
            {' '}to build your app.
          </Text>
        </Card>
      </div>
    </PageLayout>
  );
}
