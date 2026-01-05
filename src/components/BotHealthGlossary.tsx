import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { BookOpen } from 'lucide-react';

const glossaryItems = [
  {
    term: 'UP / DOWN markt',
    explanation: 'Een "UP" markt betaalt uit als de prijs boven de strike eindigt. Een "DOWN" markt betaalt uit als de prijs onder de strike eindigt. Beide kanten samen dekken alle mogelijke uitkomsten.',
  },
  {
    term: 'Pair Edge',
    explanation: 'Als je zowel UP als DOWN koopt voor minder dan $1 totaal, maak je gegarandeerd winst. Voorbeeld: UP kopen voor $0.45 + DOWN voor $0.52 = $0.97 totaal. Altijd 1 van de 2 wint en betaalt $1 uit → 3 cent winst per pair.',
  },
  {
    term: 'Inventory (positie)',
    explanation: 'De hoeveelheid shares die je bezit op UP en DOWN. Hoe meer shares, hoe meer risico als de markt de verkeerde kant op gaat.',
  },
  {
    term: 'Skew',
    explanation: 'Als je veel meer UP dan DOWN hebt (of andersom) ben je "scheef". Voorbeeld: 70 UP en 30 DOWN = scheef. Je wilt balanced zijn zodat je altijd wint ongeacht de uitkomst.',
  },
  {
    term: 'Pairing',
    explanation: 'Het proces van de andere kant erbij kopen om je positie te balanceren. Als je UP hebt gekocht, probeer je DOWN te kopen zodat je een "pair" hebt.',
  },
  {
    term: 'Unwind',
    explanation: 'Risico afbouwen door shares te verkopen. Dit doe je als de markt bijna afloopt of als je te veel risico hebt.',
  },
  {
    term: 'Emergency',
    explanation: 'Een noodactie die de bot neemt als er iets mis gaat, zoals extreme scheefstand of orders die niet werken. Dit is een "airbag" - het zou zelden voor moeten komen.',
  },
  {
    term: 'Saaie logs zijn goed',
    explanation: 'Als de bot gewoon rustig handelt en er weinig bijzondere events zijn, werkt alles naar behoren. Veel activiteit of veel fouten zijn juist een teken dat er iets mis kan gaan.',
  },
];

export function BotHealthGlossary() {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <BookOpen className="w-4 h-4" />
          Uitleg (Explain like I&apos;m 5)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Accordion type="single" collapsible className="w-full">
          {glossaryItems.map((item, idx) => (
            <AccordionItem key={idx} value={`item-${idx}`}>
              <AccordionTrigger className="text-sm hover:no-underline">
                {item.term}
              </AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                {item.explanation}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </CardContent>
    </Card>
  );
}
