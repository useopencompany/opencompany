export type MarketingCta = "demo" | "signup";

export type MarketingAnalyticsEventPropertiesByName = {
  marketing_clicked_demo: Record<string, never>;
  marketing_clicked_signup: Record<string, never>;
};

export type MarketingAnalyticsEventName = keyof MarketingAnalyticsEventPropertiesByName;

export type MarketingAnalyticsEventProperties<EventName extends MarketingAnalyticsEventName> =
  MarketingAnalyticsEventPropertiesByName[EventName];

type MarketingAnalyticsEventDefinition<EventName extends MarketingAnalyticsEventName> = {
  name: EventName;
  description: string;
  safeProperties: ReadonlyArray<keyof MarketingAnalyticsEventProperties<EventName>>;
};

export const marketingAnalyticsEvents = {
  marketing_clicked_demo: {
    name: "marketing_clicked_demo",
    description: "A visitor clicked a demo call to action.",
    safeProperties: [],
  },
  marketing_clicked_signup: {
    name: "marketing_clicked_signup",
    description: "A visitor clicked a signup call to action.",
    safeProperties: [],
  },
} satisfies {
  [EventName in MarketingAnalyticsEventName]: MarketingAnalyticsEventDefinition<EventName>;
};
