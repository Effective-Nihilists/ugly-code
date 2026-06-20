import React, { useState } from 'react';
import { Card, Input, PageLayout, Text } from 'ugly-app/client';

export default function SearchPage(): React.ReactElement {
  const initialQ = new URLSearchParams(window.location.search).get('q') ?? '';
  const [query, setQuery] = useState(initialQ);

  function handleQueryChange(v: string): void {
    setQuery(v);
    const url = new URL(window.location.href);
    url.searchParams.set('q', v);
    window.history.replaceState(null, '', url.toString());
  }

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
          Search
        </Text>
        <div>
          <Input
            label="Search query"
            value={query}
            onChange={handleQueryChange}
            placeholder="Search..."
          />
        </div>
        <Card>
          <Text size="sm">Query parameter:</Text>
          <Text weight="bold">?q={query}</Text>
        </Card>
      </div>
    </PageLayout>
  );
}
