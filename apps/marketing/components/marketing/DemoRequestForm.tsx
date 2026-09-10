"use client";

import { Button } from "@opencompany/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@opencompany/ui/components/dialog";
import { Input } from "@opencompany/ui/components/input";
import { Label } from "@opencompany/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@opencompany/ui/components/select";
import { ArrowRight } from "@opencompany/ui/icons";
import { useRef, useState } from "react";
import {
  DEMO_COMPANY_TYPES,
  DEMO_TEAM_SIZES,
  type DemoRequest,
  demoBookingUrl,
} from "@/lib/demo-request";

export function DemoRequestForm() {
  const [companyType, setCompanyType] = useState<DemoRequest["companyType"] | null>(null);
  const [teamSize, setTeamSize] = useState<DemoRequest["teamSize"] | null>(null);
  const [bookingUrl, setBookingUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const companyRef = useRef<HTMLButtonElement>(null);
  const sizeRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <form
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (!companyType || !teamSize) {
            setError("Please select your company type and team size to continue.");
            (!companyType ? companyRef : sizeRef).current?.focus();
            return;
          }
          const formData = new FormData(event.currentTarget);
          setBookingUrl(
            demoBookingUrl({ email: String(formData.get("email")), companyType, teamSize }),
          );
          setError(null);
          setLoaded(false);
          setOpen(true);
        }}
      >
        <div className="space-y-2.5">
          <Label htmlFor="demo-email">Work email</Label>
          <Input
            id="demo-email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            required
            maxLength={254}
            className="h-12 rounded-[10px] px-4 text-base"
          />
        </div>
        <div className="space-y-2.5">
          <Label id="demo-company-label" htmlFor="demo-company">
            What best describes your company?
          </Label>
          <Select
            value={companyType}
            onValueChange={setCompanyType}
            items={DEMO_COMPANY_TYPES.map((value) => ({ label: value, value }))}
          >
            <SelectTrigger
              ref={companyRef}
              id="demo-company"
              aria-labelledby="demo-company-label"
              aria-required="true"
              aria-invalid={!!error && !companyType}
              aria-describedby={error && !companyType ? "demo-error" : undefined}
              className="h-12 rounded-[10px] px-4 text-base"
            >
              <SelectValue placeholder="Select an option" />
            </SelectTrigger>
            <SelectContent className="w-[var(--anchor-width)] rounded-xl p-2">
              {DEMO_COMPANY_TYPES.map((value) => (
                <SelectItem key={value} value={value} className="rounded-lg py-3 pl-3 text-[15px]">
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2.5">
          <Label id="demo-size-label" htmlFor="demo-size">
            How many people are on your team?
          </Label>
          <Select
            value={teamSize}
            onValueChange={setTeamSize}
            items={DEMO_TEAM_SIZES.map((value) => ({ label: value, value }))}
          >
            <SelectTrigger
              ref={sizeRef}
              id="demo-size"
              aria-labelledby="demo-size-label"
              aria-required="true"
              aria-invalid={!!error && !teamSize}
              aria-describedby={error && !teamSize ? "demo-error" : undefined}
              className="h-12 rounded-[10px] px-4 text-base"
            >
              <SelectValue placeholder="Select an option" />
            </SelectTrigger>
            <SelectContent className="w-[var(--anchor-width)] rounded-xl p-2">
              {DEMO_TEAM_SIZES.map((value) => (
                <SelectItem key={value} value={value} className="rounded-lg py-3 pl-3 text-[15px]">
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {error && (!companyType || !teamSize) ? (
          <p id="demo-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button ref={submitRef} type="submit" className="h-12 w-full rounded-[10px] text-[15px]">
          Request Demo <ArrowRight aria-hidden="true" className="size-4" />
        </Button>
        <p className="text-center text-xs text-muted-foreground leading-5">
          Next, pick a time that works for you.
          <br />
          Scheduling is powered by Cal.com.
        </p>
      </form>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          finalFocus={submitRef}
          className="w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] max-w-6xl gap-3 overflow-y-auto rounded-2xl p-4 sm:p-6"
        >
          <DialogTitle className="pr-8 text-xl">Choose a time for your demo</DialogTitle>
          <DialogDescription>
            A personal walkthrough of opencompany, with time for your questions.
          </DialogDescription>
          <div className="relative h-[min(65dvh,700px)] min-h-64">
            {!loaded ? (
              <p
                role="status"
                className="absolute inset-x-0 top-8 text-center text-sm text-muted-foreground"
              >
                Loading available times…
              </p>
            ) : null}
            {open && bookingUrl ? (
              <iframe
                src={bookingUrl}
                title="Book your opencompany demo"
                className="relative size-full rounded-lg border-0"
                onLoad={() => setLoaded(true)}
                referrerPolicy="no-referrer"
              />
            ) : null}
          </div>
          <p className="text-center text-xs text-muted-foreground">
            Calendar not loading?{" "}
            <a
              href={bookingUrl ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4"
            >
              Open scheduling in a new tab
            </a>
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
