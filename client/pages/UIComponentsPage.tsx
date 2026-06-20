import React, { useRef, useState } from 'react';
import {
  // Layout
  PageLayout,
  ScrollView,
  SimpleScrollView,
  Text,
  View,
  Card,
  Panel,
  PopupPanel,
  Image,
  // Inputs
  Button,
  Input,
  ValidatedTextInput,
  AnimatedInputWrapper,
  EnumInput,
  DatePicker,
  DateTimePicker,
  DateRangePicker,
  WheelPicker,
  SelectView,
  Pressable,
  // Feedback
  alertShowMessage,
  Toast,
  Loading,
  AnimatedLoading,
  CelebrationOverlay,
  confettiRealistic,
  confettiFireworks,
  confettiFailure,
  confettiStars,
  confettiSideCannons,
  confettiSparkle,
  confettiFall,
  confettiHearts,
  confettiEmojiBurst,
  confettiSadEmoji,
  // Lists
  FlatList,
  AnimatedList,
  AnimatedListItem,
  AnimatedPresenceList,
  Pager,
  CardStack,
  ResponsiveGrid,
  // Navigation
  TabPicker,
  HeaderTabPicker,
  TabContent,
  useSelectedTab,
  WizardView,
  SettingGroup,
  // Advanced
  DrawingCanvas,
  TransformWrapper,
  TransformComponent,
  ScrollAnimatedView,
  StaggeredAnimationContainer,
  Animated,
  useAnimatedValue,
  FeedbackButton,
  Modal,
} from 'ugly-app/client';
import type {
  TabPickerDictionary,
  FlatListHandle,
  CardStackItem,
  CardStackActions,
  WheelColumn,
  DateRangeValue,
  ToastVariant,
  ImageResult,
  LayoutSize,
} from 'ugly-app/client';

// ─── Section helper ────────────────────────────────────────────────────────────

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ marginBottom: 6 }}>
        <Text size="sm" weight="semibold">{title}</Text>
        {description && (
          <p style={{ margin: '2px 0 0', fontSize: 12, opacity: 0.55 }}>{description}</p>
        )}
      </div>
      <Card>{children}</Card>
    </div>
  );
}

// ─── Tab: Layout ───────────────────────────────────────────────────────────────

function LayoutTab(): React.ReactElement {
  return (
    <ScrollView>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '16px 16px 48px' }}>

        <Section title="Text" description="Typography scale and weight variants">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(['xs', 'sm', 'md', 'lg', 'xl', '2xl'] as const).map((size) => (
              <div key={size} style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                <span style={{ opacity: 0.4, width: 32, flexShrink: 0, fontSize: 11 }}>{size}</span>
                <Text size={size}>The quick brown fox</Text>
                <span style={{ opacity: 0.6 }}><Text size={size} weight="bold">bold</Text></span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="View" description="Flex container with optional border/background">
          <View style={{ border: '1px solid rgba(0,0,0,0.15)', borderRadius: 8, padding: 12 }}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1, background: 'var(--app-primary, #2563eb)', borderRadius: 6, padding: 8 }}>
                <Text size="xs" color="white">flex: 1</Text>
              </View>
              <View style={{ flex: 2, background: 'var(--app-primary, #2563eb)', borderRadius: 6, padding: 8, opacity: 0.7 }}>
                <Text size="xs" color="white">flex: 2</Text>
              </View>
            </View>
          </View>
        </Section>

        <Section title="Panel" description="Elevated surface container">
          <Panel>
            <Text size="sm">Panel content goes here. Use Panel for cards with a subtle background and border.</Text>
          </Panel>
        </Section>

        <Section title="Card" description="Content card with padding variants">
          <div style={{ display: 'flex', gap: 8 }}>
            {(['sm', 'md', 'lg'] as const).map((pad) => (
              <div key={pad} style={{ flex: 1 }}>
                <Card padding={pad}>
                  <Text size="xs" weight="medium">{pad}</Text>
                  <span style={{ opacity: 0.5 }}><Text size="xs">padding</Text></span>
                </Card>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Image" description="Image with resize modes">
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {(['cover', 'contain', 'center'] as const).map((mode) => (
              <div key={mode} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <Image
                  src={{ url: 'https://placehold.co/120x80' }}
                  resizeMode={mode}
                  style={{ width: 120, height: 80, borderRadius: 6 }}
                />
                <span style={{ opacity: 0.5 }}><Text size="xs">{mode}</Text></span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="ScrollView" description="Scrollable container that integrates with scroll indicators">
          <div style={{ height: 80, border: '1px dashed rgba(0,0,0,0.2)', borderRadius: 8, overflow: 'hidden' }}>
            <ScrollView>
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} style={{ padding: '6px 12px', borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                  <Text size="sm">Scroll item {i + 1}</Text>
                </div>
              ))}
            </ScrollView>
          </div>
        </Section>

        <Section title="SimpleScrollView" description="Lightweight scroll wrapper without scroll context — use for nested scrollable areas">
          <div style={{ height: 80, border: '1px dashed rgba(0,0,0,0.2)', borderRadius: 8, overflow: 'hidden' }}>
            <SimpleScrollView style={{ height: '100%', overflowY: 'auto' }}>
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} style={{ padding: '6px 12px', borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                  <Text size="sm">Item {i + 1}</Text>
                </div>
              ))}
            </SimpleScrollView>
          </div>
        </Section>

        <Section title="PopupPanel" description="Slide-up panel for popups (opened via useRouter().openPopup())">
          <span style={{ opacity: 0.6 }}>
            <Text size="sm">
              PopupPanel is a container used inside popups opened with{' '}
              <code style={{ fontSize: 12 }}>useRouter().openPopup()</code>.
              It provides consistent padding and a drag handle.
            </Text>
          </span>
          <div style={{ marginTop: 8, border: '1px dashed rgba(0,0,0,0.2)', borderRadius: 12, overflow: 'hidden' }}>
            <PopupPanel>
              <Text size="sm">Popup content renders inside PopupPanel</Text>
            </PopupPanel>
          </div>
        </Section>

      </div>
    </ScrollView>
  );
}

// ─── Tab: Inputs ───────────────────────────────────────────────────────────────

function InputsTab(): React.ReactElement {
  const [inputVal, setInputVal] = useState('');
  const [validatedVal, setValidatedVal] = useState('');
  const [enumVal, setEnumVal] = useState<'a' | 'b' | 'c'>('a');
  const [dateVal, setDateVal] = useState<string | null>(null);
  const [dateTimeVal, setDateTimeVal] = useState<number | null>(null);
  const [dateRangeVal, setDateRangeVal] = useState<DateRangeValue>({
    preset: 'last7Days',
    customStartDate: null,
    customEndDate: null,
  });
  const [wheelHour, setWheelHour] = useState(0);
  const [wheelMin, setWheelMin] = useState(0);
  const [selectVal, setSelectVal] = useState<'alpha' | 'beta' | 'gamma' | 'delta' | undefined>(undefined);
  const [animInputVal, setAnimInputVal] = useState('');
  const [animFocused, setAnimFocused] = useState(false);
  const [pressed, setPressed] = useState(false);

  const hourCol: WheelColumn = {
    values: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')),
    selectedIndex: wheelHour,
    onSelect: setWheelHour,
    width: 60,
  };
  const minCol: WheelColumn = {
    values: Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0')),
    selectedIndex: wheelMin,
    onSelect: setWheelMin,
    width: 60,
  };

  return (
    <ScrollView>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '16px 16px 48px' }}>

        <Section title="Button" description="Primary, secondary, and error variants">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="error">Error</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="primary" disabled>Disabled</Button>
          </div>
        </Section>

        <Section title="Input" description="Controlled text input">
          <Input
            value={inputVal}
            onChange={(value) => { setInputVal(value); }}
            placeholder="Type something..."
          />
          {inputVal && (
            <span style={{ marginTop: 6, display: 'block' }}>
              <Text size="xs">Value: {inputVal}</Text>
            </span>
          )}
        </Section>

        <Section title="ValidatedTextInput" description="Input with inline validation via onValueChanged">
          <ValidatedTextInput
            value={validatedVal}
            valueToText={(v: string) => v}
            textToValue={(t: string) => t}
            onValueChanged={(value: string, showError: (x: unknown) => void) => {
              if (value.length > 0 && value.length < 3) {
                showError('Minimum 3 characters required');
              }
              setValidatedVal(value);
            }}
            placeholder="Min 3 characters"
          />
        </Section>

        <Section title="AnimatedInputWrapper" description="Focus ring animation wrapper for any input element">
          <AnimatedInputWrapper isFocused={animFocused}>
            <input
              value={animInputVal}
              onChange={(e) => { setAnimInputVal(e.target.value); }}
              onFocus={() => { setAnimFocused(true); }}
              onBlur={() => { setAnimFocused(false); }}
              placeholder="Click to see focus animation"
              style={{
                width: '100%',
                padding: '10px 12px',
                border: '1px solid rgba(0,0,0,0.15)',
                borderRadius: 8,
                fontSize: 16,
                outline: 'none',
                background: 'transparent',
                color: 'inherit',
                boxSizing: 'border-box',
              }}
            />
          </AnimatedInputWrapper>
        </Section>

        <Section title="EnumInput" description="Dropdown selector for enum values">
          <EnumInput
            value={enumVal}
            onChange={setEnumVal}
            options={[
              { value: 'a', label: 'Option A' },
              { value: 'b', label: 'Option B' },
              { value: 'c', label: 'Option C' },
            ]}
          />
          <span style={{ marginTop: 6, opacity: 0.5, display: 'block' }}>
            <Text size="xs">Selected: {enumVal}</Text>
          </span>
        </Section>

        <Section title="DatePicker" description="Calendar date selector (returns YYYY-MM-DD string)">
          <DatePicker value={dateVal} onValueChanged={setDateVal} />
          {dateVal && (
            <span style={{ marginTop: 6, opacity: 0.5, display: 'block' }}>
              <Text size="xs">Selected: {dateVal}</Text>
            </span>
          )}
        </Section>

        <Section title="DateTimePicker" description="Date and time selector (returns Unix timestamp ms)">
          <DateTimePicker value={dateTimeVal} onValueChanged={setDateTimeVal} />
          {dateTimeVal !== null && (
            <span style={{ marginTop: 6, opacity: 0.5, display: 'block' }}>
              <Text size="xs">Selected: {new Date(dateTimeVal).toLocaleString()}</Text>
            </span>
          )}
        </Section>

        <Section title="DateRangePicker" description="Preset or custom date range selector">
          <DateRangePicker value={dateRangeVal} onChange={setDateRangeVal} />
        </Section>

        <Section title="WheelPicker" description="iOS-style scroll wheel selector">
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <Text size="lg" weight="bold">
              {String(wheelHour).padStart(2, '0')}:{String(wheelMin).padStart(2, '0')}
            </Text>
            <WheelPicker columns={[hourCol, minCol]} />
          </div>
        </Section>

        <Section title="SelectView" description="List-based single or multi-select">
          <SelectView
            items={[
              { value: 'alpha', text: 'Alpha', description: 'First option' },
              { value: 'beta', text: 'Beta', description: 'Second option' },
              { value: 'gamma', text: 'Gamma', description: 'Third option' },
              { value: 'delta', text: 'Delta', description: 'Fourth option' },
            ]}
            value={selectVal}
            onChange={setSelectVal}
          />
          {selectVal && (
            <span style={{ marginTop: 6, opacity: 0.5, display: 'block' }}>
              <Text size="xs">Selected: {selectVal}</Text>
            </span>
          )}
        </Section>

        <Section title="Pressable" description="Pressable area with visual feedback">
          <Pressable
            onPress={() => { setPressed((p) => !p); }}
            style={{
              padding: 16,
              borderRadius: 8,
              border: '1px solid rgba(0,0,0,0.1)',
              textAlign: 'center',
              cursor: 'pointer',
            }}
          >
            <Text weight="medium">{pressed ? 'Pressed! (tap again to reset)' : 'Tap me'}</Text>
          </Pressable>
        </Section>

      </div>
    </ScrollView>
  );
}

// ─── Tab: Feedback ─────────────────────────────────────────────────────────────

function FeedbackTab(): React.ReactElement {
  const [showModal, setShowModal] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [toastVariant, setToastVariant] = useState<ToastVariant>('info');
  const [showCelebration, setShowCelebration] = useState(false);

  const confettiFns: { label: string; fn: () => void }[] = [
    { label: 'Realistic', fn: confettiRealistic },
    { label: 'Fireworks', fn: confettiFireworks },
    { label: 'Failure', fn: confettiFailure },
    { label: 'Stars', fn: confettiStars },
    { label: 'Cannons', fn: confettiSideCannons },
    { label: 'Sparkle', fn: confettiSparkle },
    { label: 'Fall', fn: confettiFall },
    { label: 'Hearts', fn: confettiHearts },
    { label: 'Emoji Burst', fn: confettiEmojiBurst },
    { label: 'Sad Emoji', fn: confettiSadEmoji },
  ];

  return (
    <ScrollView>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '16px 16px 48px' }}>

        <Section title="Modal" description="Overlay dialog with backdrop dismiss">
          <Button variant="primary" onClick={() => { setShowModal(true); }}>Open Modal</Button>
          {showModal && (
            <Modal onClose={() => { setShowModal(false); }}>
              <div style={{ padding: 24, maxWidth: 360 }}>
                <Text size="lg" weight="bold">Modal Title</Text>
                <span style={{ marginTop: 8, opacity: 0.6, display: 'block' }}>
                  <Text size="sm">
                    This is the modal body. Click outside or the button below to close.
                  </Text>
                </span>
                <div style={{ marginTop: 16 }}>
                  <Button variant="secondary" onClick={() => { setShowModal(false); }}>Close</Button>
                </div>
              </div>
            </Modal>
          )}
        </Section>

        <Section title="AlertPopup / alertShowMessage" description="Imperative top-banner alert (no JSX state required)">
          <Button variant="secondary" onClick={() => { alertShowMessage('Hello from alertShowMessage!'); }}>
            Show Alert
          </Button>
        </Section>

        <Section title="Toast" description="Auto-dismissing notification banner">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <EnumInput
              value={toastVariant}
              onChange={setToastVariant}
              options={[
                { value: 'info', label: 'Info' },
                { value: 'success', label: 'Success' },
                { value: 'warning', label: 'Warning' },
                { value: 'error', label: 'Error' },
              ]}
            />
            <Button
              variant="primary"
              onClick={() => { setShowToast(true); }}
              disabled={showToast}
            >
              Show Toast
            </Button>
          </div>
          {showToast && (
            <Toast
              message={`This is a ${toastVariant} toast message.`}
              variant={toastVariant}
              onDismiss={() => { setShowToast(false); }}
            />
          )}
        </Section>

        <Section title="Loading" description="Spinner at multiple sizes (size is in pixels)">
          <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
            {([16, 24, 40] as const).map((size) => (
              <div key={size} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <Loading size={size} />
                <Text size="xs">{size}px</Text>
              </div>
            ))}
          </div>
        </Section>

        <Section title="AnimatedLoading" description="Loading indicator with animated status messages">
          <AnimatedLoading />
        </Section>

        <Section title="CelebrationOverlay" description="Fullscreen celebration animation">
          <div style={{ position: 'relative', minHeight: 80 }}>
            <Button variant="primary" onClick={() => { setShowCelebration(true); }}>
              Celebrate!
            </Button>
            <CelebrationOverlay
              show={showCelebration}
              title="You did it!"
              subtitle="Keep up the great work"
              onDismiss={() => { setShowCelebration(false); }}
            />
          </div>
        </Section>

        <Section title="Confetti" description="10 canvas-confetti presets — fire and forget">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {confettiFns.map(({ label, fn }) => (
              <Button key={label} variant="secondary" onClick={() => { fn(); }}>
                {label}
              </Button>
            ))}
          </div>
        </Section>

      </div>
    </ScrollView>
  );
}

// ─── Tab: Lists ────────────────────────────────────────────────────────────────

function ListsTab(): React.ReactElement {
  const flatListRef = useRef<FlatListHandle>(null);
  const [animatedItems, setAnimatedItems] = useState(['Alpha', 'Beta', 'Gamma']);
  const [presenceItems, setPresenceItems] = useState(['One', 'Two', 'Three', 'Four']);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments
  const [cardItems] = useState<CardStackItem<{ label: string }>[]>([
    { id: '1', data: { label: 'Card One' } },
    { id: '2', data: { label: 'Card Two' } },
    { id: '3', data: { label: 'Card Three' } },
    { id: '4', data: { label: 'Card Four' } },
    { id: '5', data: { label: 'Card Five' } },
  ]);

  return (
    <ScrollView>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '16px 16px 48px' }}>

        <Section title="FlatList" description="Virtualized list with scroll management">
          <div style={{ height: 160, overflow: 'hidden', borderRadius: 8, border: '1px solid rgba(0,0,0,0.08)' }}>
            <FlatList
              listRef={flatListRef}
              data={['Item 1', 'Item 2', 'Item 3', 'Item 4', 'Item 5', 'Item 6', 'Item 7']}
              keyExtractor={(item) => item}
              renderItem={({ item, index }: { item: string; index: number }) => (
                <div
                  key={index}
                  style={{ padding: '10px 14px', borderBottom: '1px solid rgba(0,0,0,0.06)' }}
                >
                  <Text size="sm">{item}</Text>
                </div>
              )}
            />
          </div>
        </Section>

        <Section title="AnimatedList / AnimatedListItem" description="List with slide-in animations for new items">
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <Button
              variant="primary"
              onClick={() => {
                const next = `Item ${Date.now() % 10000}`;
                setAnimatedItems((prev) => [next, ...prev]);
              }}
            >
              Add Item
            </Button>
            <Button
              variant="secondary"
              onClick={() => { setAnimatedItems((prev) => prev.slice(1)); }}
              disabled={animatedItems.length === 0}
            >
              Remove First
            </Button>
          </div>
          <AnimatedList>
            {animatedItems.map((item) => (
              <AnimatedListItem key={item} itemKey={item} variant="slide">
                <div style={{ padding: '8px 12px', marginBottom: 4, borderRadius: 6, background: 'rgba(0,0,0,0.04)' }}>
                  <Text size="sm">{item}</Text>
                </div>
              </AnimatedListItem>
            ))}
          </AnimatedList>
        </Section>

        <Section title="AnimatedPresenceList" description="List with exit animations when items are removed">
          <div style={{ marginBottom: 10 }}>
            <Button
              variant="secondary"
              onClick={() => { setPresenceItems((prev) => prev.slice(1)); }}
              disabled={presenceItems.length === 0}
            >
              Remove First
            </Button>
          </div>
          <AnimatedPresenceList
            items={presenceItems}
            keyExtractor={(item: string) => item}
            variant="fade"
            renderItem={(item: string, _index: number, isExiting: boolean) => (
              <div
                style={{
                  padding: '8px 12px',
                  marginBottom: 4,
                  borderRadius: 6,
                  background: 'rgba(0,0,0,0.04)',
                  opacity: isExiting ? 0.3 : 1,
                  transition: 'opacity 0.2s',
                }}
              >
                <Text size="sm">{item}</Text>
              </div>
            )}
          />
          {presenceItems.length === 0 && (
            <Button variant="secondary" onClick={() => { setPresenceItems(['One', 'Two', 'Three', 'Four']); }}>
              Reset
            </Button>
          )}
        </Section>

        <Section title="Pager" description="Horizontally paginated slides with dot indicators">
          <div style={{ height: 120, overflow: 'hidden', borderRadius: 8, border: '1px solid rgba(0,0,0,0.08)' }}>
            <Pager
              items={[
                <div key="1" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--app-primary, #2563eb)', borderRadius: 8 }}>
                  <Text weight="bold" color="white">Slide 1</Text>
                </div>,
                <div key="2" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#7c3aed', borderRadius: 8 }}>
                  <Text weight="bold" color="white">Slide 2</Text>
                </div>,
                <div key="3" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#059669', borderRadius: 8 }}>
                  <Text weight="bold" color="white">Slide 3</Text>
                </div>,
              ]}
              delay={0}
              showArrows
            />
          </div>
        </Section>

        <Section title="CardStack" description="Swipeable card stack — drag or use buttons">
          <div style={{ height: 220, position: 'relative', overflow: 'hidden' }}>
            <CardStack
              items={cardItems}
              renderCard={(item: { label: string }, actions: CardStackActions) => (
                <div style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 16 }}>
                  <Text size="lg" weight="bold">{item.label}</Text>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button variant="error" onClick={actions.dislike}>✕ Pass</Button>
                    <Button variant="primary" onClick={actions.like}>✓ Like</Button>
                  </div>
                </div>
              )}
            />
          </div>
        </Section>

        <Section title="ResponsiveGrid" description="Grid with automatic responsive column sizing">
          <ResponsiveGrid
            data={['A', 'B', 'C', 'D', 'E', 'F']}
            columns={3}
            spacing={8}
            getItemHeight={(w: number) => w}
            renderItem={(item: string, size: LayoutSize) => (
              <div
                style={{
                  width: size.width,
                  height: size.height,
                  background: 'var(--app-primary, #2563eb)',
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text weight="bold" color="white">{item}</Text>
              </div>
            )}
          />
        </Section>

      </div>
    </ScrollView>
  );
}

// ─── Tab: Navigation ───────────────────────────────────────────────────────────

type MiniTab = 'alpha' | 'beta' | 'gamma';
const MINI_TABS: MiniTab[] = ['alpha', 'beta', 'gamma'];

type HeaderMiniTab = 'x' | 'y';
const HEADER_MINI_TABS: HeaderMiniTab[] = ['x', 'y'];

function NavigationTab(): React.ReactElement {
  const [miniTab, setMiniTab] = useState<MiniTab>('alpha');
  const [headerMiniTab, setHeaderMiniTab] = useState<HeaderMiniTab>('x');
  const [wizardStep, setWizardStep] = useState(0);
  const [wizardDone, setWizardDone] = useState(false);

  const miniTabDictionary: TabPickerDictionary<MiniTab> = {
    alpha: { text: 'Alpha', content: <Text size="sm">Content for the Alpha tab.</Text> },
    beta: { text: 'Beta', content: <Text size="sm">Content for the Beta tab.</Text> },
    gamma: { text: 'Gamma', content: <Text size="sm">Content for the Gamma tab.</Text> },
  };

  const headerMiniDictionary: TabPickerDictionary<HeaderMiniTab> = {
    x: { text: 'Option X', content: null },
    y: { text: 'Option Y', content: null },
  };

  return (
    <ScrollView>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '16px 16px 48px' }}>

        <Section title="TabPicker" description="Underline-style tab bar (used for this page's own tabs)">
          <div style={{ border: '1px solid rgba(0,0,0,0.08)', borderRadius: 8, overflow: 'hidden' }}>
            <TabPicker
              tabs={MINI_TABS}
              tabDictionary={miniTabDictionary}
              selectedTab={miniTab}
              setSelectedTab={setMiniTab}
            />
            <div style={{ padding: 16 }}>
              <TabContent
                tabs={MINI_TABS}
                tabDictionary={miniTabDictionary}
                selectedTab={miniTab}
              />
            </div>
          </div>
        </Section>

        <Section title="HeaderTabPicker" description="Pill/segment-style tab selector for headers">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <HeaderTabPicker
              tabs={HEADER_MINI_TABS}
              tabDictionary={headerMiniDictionary}
              selectedTab={headerMiniTab}
              setSelectedTab={setHeaderMiniTab}
            />
            <span style={{ opacity: 0.6 }}><Text size="sm">Selected: {headerMiniTab}</Text></span>
          </div>
        </Section>

        <Section title="WizardView" description="Multi-step form with progress bar and navigation">
          {wizardDone ? (
            <div style={{ padding: 16, textAlign: 'center' }}>
              <Text size="lg" weight="bold">Wizard completed!</Text>
              <div style={{ marginTop: 12 }}>
                <Button variant="secondary" onClick={() => { setWizardDone(false); setWizardStep(0); }}>
                  Reset
                </Button>
              </div>
            </div>
          ) : (
            <div style={{ height: 320, position: 'relative', overflow: 'hidden' }}>
              <WizardView
                steps={[
                  {
                    key: 's1',
                    content: (
                      <div style={{ padding: 16 }}>
                        <Text size="lg" weight="bold">Step 1: Welcome</Text>
                        <span style={{ marginTop: 8, opacity: 0.6, display: 'block' }}>
                          <Text size="sm">First step of the wizard. Click Next to continue.</Text>
                        </span>
                      </div>
                    ),
                    canProceed: true,
                  },
                  {
                    key: 's2',
                    content: (
                      <div style={{ padding: 16 }}>
                        <Text size="lg" weight="bold">Step 2: Configure</Text>
                        <span style={{ marginTop: 8, opacity: 0.6, display: 'block' }}>
                          <Text size="sm">Second step. Back and Next buttons appear automatically.</Text>
                        </span>
                      </div>
                    ),
                    canProceed: true,
                  },
                  {
                    key: 's3',
                    content: (
                      <div style={{ padding: 16 }}>
                        <Text size="lg" weight="bold">Step 3: Confirm</Text>
                        <span style={{ marginTop: 8, opacity: 0.6, display: 'block' }}>
                          <Text size="sm">Final step. Press Done to complete the wizard.</Text>
                        </span>
                      </div>
                    ),
                    canProceed: true,
                  },
                ]}
                currentStep={wizardStep}
                onStepChange={setWizardStep}
                onComplete={() => { setWizardDone(true); }}
                progressStyle="bar"
              />
            </div>
          )}
        </Section>

        <Section title="SettingGroup" description="Grouped settings rows with label and dividers">
          <SettingGroup
            label="Preferences"
            items={[
              <div key="notif" style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                <div>
                  <Text size="sm" weight="medium">Notifications</Text>
                  <span style={{ opacity: 0.5 }}><Text size="xs">Receive push notifications</Text></span>
                </div>
                <span style={{ opacity: 0.4 }}><Text size="sm">On</Text></span>
              </div>,
              <div key="dark" style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                <div>
                  <Text size="sm" weight="medium">Dark mode</Text>
                  <span style={{ opacity: 0.5 }}><Text size="xs">Use system default</Text></span>
                </div>
                <span style={{ opacity: 0.4 }}><Text size="sm">Auto</Text></span>
              </div>,
              <div key="lang" style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                <div>
                  <Text size="sm" weight="medium">Language</Text>
                  <span style={{ opacity: 0.5 }}><Text size="xs">Display language</Text></span>
                </div>
                <span style={{ opacity: 0.4 }}><Text size="sm">English</Text></span>
              </div>,
            ]}
          />
        </Section>

      </div>
    </ScrollView>
  );
}

// ─── Tab: Advanced ─────────────────────────────────────────────────────────────

function AdvancedTab(): React.ReactElement {
  const [drawingDone, setDrawingDone] = useState(false);
  const [drawnImage, setDrawnImage] = useState<string | null>(null);
  const [staggerKey, setStaggerKey] = useState(0);
  const opacityAnim = useAnimatedValue(1);
  const [isHidden, setIsHidden] = useState(false);

  function handleDrawingComplete(result: ImageResult): void {
    setDrawingDone(true);
    setDrawnImage(`data:${result.mime};base64,${result.base64}`);
  }

  function toggleOpacity(): void {
    const target = isHidden ? 1 : 0.15;
    void opacityAnim.start(target);
    setIsHidden((prev) => !prev);
  }

  return (
    <ScrollView>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '16px 16px 48px' }}>

        <Section title="DrawingCanvas" description="Freehand drawing canvas with color picker and eraser">
          <div style={{ maxWidth: 400, margin: '0 auto' }}>
            {drawingDone ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {drawnImage && (
                  <img
                    src={drawnImage}
                    alt="Your drawing"
                    style={{ width: '100%', borderRadius: 8, border: '1px solid rgba(0,0,0,0.1)' }}
                  />
                )}
                <Button
                  variant="secondary"
                  onClick={() => { setDrawingDone(false); setDrawnImage(null); }}
                >
                  Draw Again
                </Button>
              </div>
            ) : (
              <DrawingCanvas
                onComplete={handleDrawingComplete}
                onCancel={() => { setDrawingDone(false); setDrawnImage(null); }}
                size={512}
              />
            )}
          </div>
        </Section>

        <Section title="TransformWrapper / TransformComponent" description="Pinch-to-zoom and pan for any content">
          <span style={{ opacity: 0.5, display: 'block', marginBottom: 8 }}>
            <Text size="xs">Scroll or pinch to zoom, drag to pan</Text>
          </span>
          <div style={{ overflow: 'hidden', borderRadius: 8, border: '1px solid rgba(0,0,0,0.08)' }}>
            <TransformWrapper>
              <TransformComponent>
                <img
                  src="https://placehold.co/400x250"
                  alt="Zoom me"
                  style={{ width: 400, height: 250, display: 'block' }}
                />
              </TransformComponent>
            </TransformWrapper>
          </div>
        </Section>

        <Section title="ScrollAnimatedView" description="Animate children when they scroll into view">
          <span style={{ opacity: 0.5, display: 'block', marginBottom: 8 }}>
            <Text size="xs">Items animate in as they enter the viewport (scroll down if needed)</Text>
          </span>
          {['First item', 'Second item', 'Third item'].map((text, i) => (
            <ScrollAnimatedView key={text} animation="slideUp" delay={i * 100} threshold={0.1}>
              <div style={{ padding: '12px 16px', marginBottom: 8, borderRadius: 8, background: 'rgba(0,0,0,0.04)', width: '100%' }}>
                <Text size="sm">{text}</Text>
              </div>
            </ScrollAnimatedView>
          ))}
        </Section>

        <Section title="StaggeredAnimationContainer" description="Staggered entry animation for a group of children">
          <div style={{ marginBottom: 10 }}>
            <Button variant="secondary" onClick={() => { setStaggerKey((k) => k + 1); }}>
              Replay
            </Button>
          </div>
          <StaggeredAnimationContainer key={staggerKey} animation="fadeIn" baseDelay={100}>
            {['Item A', 'Item B', 'Item C', 'Item D'].map((label) => (
              <div
                key={label}
                style={{ padding: '8px 12px', marginBottom: 6, borderRadius: 6, background: 'rgba(0,0,0,0.04)' }}
              >
                <Text size="sm">{label}</Text>
              </div>
            ))}
          </StaggeredAnimationContainer>
        </Section>

        <Section title="Animated + useAnimatedValue" description="Animate any CSS property with spring physics">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Button variant="secondary" onClick={toggleOpacity}>
              {isHidden ? 'Fade in' : 'Fade out'}
            </Button>
            <Animated.div
              style={{
                opacity: opacityAnim,
                padding: 16,
                borderRadius: 8,
                background: 'var(--app-primary, #2563eb)',
              }}
            >
              <Text weight="bold" color="white">Animated opacity via useAnimatedValue</Text>
            </Animated.div>
          </div>
        </Section>

        <Section title="FeedbackButton" description="Built-in user feedback button (always present at bottom-right via AppProvider)">
          <span style={{ opacity: 0.6, display: 'block', marginBottom: 12 }}>
            <Text size="sm">
              The feedback button is automatically added by{' '}
              <code style={{ fontSize: 12 }}>AppProvider</code> and appears at the
              bottom-right of every page at{' '}
              <code style={{ fontSize: 12 }}>[data-id="feedback-button"]</code>.
            </Text>
          </span>
          <FeedbackButton />
        </Section>

      </div>
    </ScrollView>
  );
}

// ─── Page shell ────────────────────────────────────────────────────────────────

type TabId = 'layout' | 'inputs' | 'feedback' | 'lists' | 'navigation' | 'advanced';
const TABS: TabId[] = ['layout', 'inputs', 'feedback', 'lists', 'navigation', 'advanced'];

export default function UIComponentsPage(): React.ReactElement {
  const [selectedTab, setSelectedTab] = useSelectedTab<TabId>('layout', TABS, 'ui-components-tab');

  const tabDictionary: TabPickerDictionary<TabId> = {
    layout:     { text: 'Layout',     content: <LayoutTab /> },
    inputs:     { text: 'Inputs',     content: <InputsTab /> },
    feedback:   { text: 'Feedback',   content: <FeedbackTab /> },
    lists:      { text: 'Lists',      content: <ListsTab /> },
    navigation: { text: 'Navigation', content: <NavigationTab /> },
    advanced:   { text: 'Advanced',   content: <AdvancedTab /> },
  };

  return (
    <PageLayout
      header={
        <div>
          <div style={{ padding: '12px 16px 4px' }}>
            <a href="/test" style={{ fontSize: 13, opacity: 0.5, textDecoration: 'none' }}>← Tests</a>
          </div>
          <div style={{ padding: '4px 16px 8px' }}>
            <Text size="xl" weight="bold">UI Components</Text>
            <span style={{ opacity: 0.5, display: 'block' }}>
              <Text size="sm">Live demos of all built-in components</Text>
            </span>
          </div>
          <TabPicker
            tabs={TABS}
            tabDictionary={tabDictionary}
            selectedTab={selectedTab}
            setSelectedTab={setSelectedTab}
          />
        </div>
      }
    >
      <TabContent tabs={TABS} tabDictionary={tabDictionary} selectedTab={selectedTab} />
    </PageLayout>
  );
}
