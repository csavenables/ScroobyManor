# Scrooby Manor Analytics Setup

This project ships a non-blocking telemetry layer for the Scrooby Manor viewer.

## 1) Create a dedicated Supabase project

- Create a new Supabase project (Scrooby-only).
- Keep this separate from other demos.

## 2) Apply schema + views

Run these SQL files in the Supabase SQL editor:

1. `supabase/schema.sql`
2. `supabase/analytics/views.sql`

This creates:

- `public.sessions`
- `public.events`
- Daily aggregate views for funnel/device/geo/perf/reliability/annotations.

## 3) Deploy the ingest function

From this repo root:

```bash
supabase functions deploy ingest-event
```

Set function env vars:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

If using local dev:

```bash
supabase functions serve ingest-event --env-file .env.local
```

## 4) Configure scene endpoint

Update `public/scenes/sm-orbit-1-trimmed/scene.json`:

```json
"analytics": {
  "enabled": true,
  "endpoint": "https://<PROJECT_REF>.supabase.co/functions/v1/ingest-event",
  "project": "sm-orbit-1-trimmed"
}
```

Telemetry is enabled by default, but is disabled when:

- browser DNT is on (`navigator.doNotTrack === "1"`)
- URL includes `?analytics=0`

Force-enable for testing with `?analytics=1`.

## 5) Event coverage included

- Session lifecycle: `viewer_opened`, `session_ended`
- Load flow: `scene_load_started`, `asset_loaded`, `asset_load_timing`, `intro_started`, `intro_completed`
- Buttons/CTA: `button_pressed`, `enter_experience_clicked`, `website_cta_clicked`, replay/theme/fullscreen actions
- Annotations: `annotation_pin_selected`, `annotation_prev`, `annotation_next`, `annotation_close`
- Interaction depth: `interaction_start`, `interaction_end`, `time_to_first_interaction`
- Errors: `viewer_error`, `failed_asset_load`, `telemetry_send_failed`

## 6) Validation checklist

1. Open viewer with `?analytics=1`.
2. Confirm function receives POST requests.
3. Confirm rows appear in `sessions` and `events`.
4. Trigger annotation nav/buttons and confirm matching events.
5. Reload with `?analytics=0` and confirm no outbound telemetry.

## 7) Query snippets (George dashboard starter)

Sessions per day:

```sql
select * from public.analytics_sessions_daily order by day desc;
```

Device/OS mix:

```sql
select * from public.analytics_device_mix_daily order by day desc, sessions desc;
```

Button clicks:

```sql
select * from public.analytics_button_clicks_daily order by day desc, clicks desc;
```

Annotation engagement:

```sql
select * from public.analytics_annotation_daily order by day desc;
```

CTA click-through:

```sql
select * from public.analytics_funnel_daily order by day desc;
```

Performance/reliability:

```sql
select * from public.analytics_perf_daily order by day desc;
select * from public.analytics_reliability_daily order by day desc;
```
