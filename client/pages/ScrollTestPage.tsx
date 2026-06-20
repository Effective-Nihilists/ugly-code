import React from 'react';
import {
  PageLayout,
  ScrollView,
  SimpleScrollView,
  FlatList,
  Text,
} from 'ugly-app/client';
import type { FlatListHandle } from 'ugly-app/client';

const LARGE_COUNT = 100;
const SHORT_COUNT = 3;

function makeItems(count: number) {
  return Array.from({ length: count }, (_, i) => `Item ${i + 1}`);
}

const largeItems = makeItems(LARGE_COUNT);
const shortItems = makeItems(SHORT_COUNT);

function ItemRow({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: '8px 12px',
        borderBottom: '1px solid rgba(0,0,0,0.06)',
      }}
    >
      <Text size="sm">{label}</Text>
    </div>
  );
}

const CONTAINER_STYLE: React.CSSProperties = {
  height: 300,
  marginTop: 16,
  border: '1px solid #ccc',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};

export default function ScrollTestPage() {
  const flatListRef = React.useRef<FlatListHandle>(null);
  const shortFlatListRef = React.useRef<FlatListHandle>(null);

  return (
    <PageLayout>
      <div style={{ padding: 16, maxWidth: 800, margin: '0 auto' }}>
        <Text size="lg" weight="bold">
          Scroll Component Tests
        </Text>

        {/* ScrollView - Large */}
        <div data-id="scrollview-large" style={CONTAINER_STYLE}>
          <ScrollView hideScrollIndicator>
            {largeItems.map((label) => (
              <ItemRow key={label} label={label} />
            ))}
          </ScrollView>
        </div>

        {/* ScrollView - Short */}
        <div data-id="scrollview-short" style={CONTAINER_STYLE}>
          <ScrollView hideScrollIndicator>
            {shortItems.map((label) => (
              <ItemRow key={label} label={label} />
            ))}
          </ScrollView>
        </div>

        {/* SimpleScrollView - Large */}
        <div data-id="simple-large" style={CONTAINER_STYLE}>
          <SimpleScrollView>
            {largeItems.map((label) => (
              <ItemRow key={label} label={label} />
            ))}
          </SimpleScrollView>
        </div>

        {/* SimpleScrollView - Short */}
        <div data-id="simple-short" style={CONTAINER_STYLE}>
          <SimpleScrollView>
            {shortItems.map((label) => (
              <ItemRow key={label} label={label} />
            ))}
          </SimpleScrollView>
        </div>

        {/* FlatList - Large */}
        <div data-id="flatlist-large" style={CONTAINER_STYLE}>
          <FlatList
            listRef={flatListRef}
            data={largeItems}
            keyExtractor={(item) => item}
            renderItem={({ item }) => <ItemRow label={item} />}
          />
        </div>

        {/* FlatList - Short */}
        <div data-id="flatlist-short" style={CONTAINER_STYLE}>
          <FlatList
            listRef={shortFlatListRef}
            data={shortItems}
            keyExtractor={(item) => item}
            renderItem={({ item }) => <ItemRow label={item} />}
          />
        </div>
      </div>
    </PageLayout>
  );
}
