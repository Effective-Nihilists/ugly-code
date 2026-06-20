import { PageLayout, Text } from 'ugly-app/client';

/** SPA-nav target for inspect-fixture tests. */
export default function InspectFixtureOtherPage() {
  return (
    <PageLayout>
      <div style={{ padding: 16 }}>
        <Text data-id="other-page-title" size="xl" weight="bold">
          Other page
        </Text>
      </div>
    </PageLayout>
  );
}
