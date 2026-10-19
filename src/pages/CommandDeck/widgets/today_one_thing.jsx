import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { C } from '../deckConstants';
import { Card, MicField, inputStyle } from '../DeckUI';

export default function TodayOneThingWidget() {
  const { focusTask, saveFocus } = useCommandDeck();
  return (
    <Card title="Today's one thing" sub="Not the list. Just this." style={{ background: C.walnut, color: C.paper, border: `1.5px solid ${C.gold}` }} titleColor={C.brassLight} subColor="rgba(246,240,223,0.65)">
      <MicField
        value={focusTask}
        onChange={saveFocus}
        placeholder="What's the single most important thing?"
        style={{ ...inputStyle, background: 'rgba(246,240,223,0.08)', border: '1px solid rgba(246,240,223,0.25)', color: C.paper }}
        micColor="rgba(246,240,223,0.15)"
      />
    </Card>
  );
}
