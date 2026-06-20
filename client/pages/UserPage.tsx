import React from 'react';
import { Card, PageLayout, Text } from 'ugly-app/client';

export default function UserPage({
  userId,
}: {
  userId: string;
}): React.ReactElement {
  return (
    <PageLayout
      header={
        <div>
          <a href="/">← Home</a>
        </div>
      }
    >
      <div>
        <Text size="xl" weight="bold">
          User Profile
        </Text>
        <Card>
          <Text size="sm">Path parameter:</Text>
          <Text weight="bold">/user/{userId}</Text>
          <Text size="sm">
            userId = <code>{userId}</code>
          </Text>
        </Card>
      </div>
    </PageLayout>
  );
}
