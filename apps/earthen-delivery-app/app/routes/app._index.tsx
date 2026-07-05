import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { formBoolean, formNumber } from "../delivery/forms";
import {
  deliverySettingsSchema,
  getDeliveryEstimate,
  getDeliverySettings,
  invalidateDeliverySettings,
  PINCODE_PATTERN,
  updateDeliverySettings,
} from "../delivery/delivery";

const WEEKDAYS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getDeliverySettings(db, session.shop);

  return {
    enabled: settings.enabled,
    pickupPincode: settings.pickupPincode,
    cutoffHour: settings.cutoffHour,
    workingDays: settings.workingDays
      .split(",")
      .map((d) => Number.parseInt(d, 10))
      .filter((d) => d >= 1 && d <= 7),
    holidays: (Array.isArray(settings.holidays) ? settings.holidays : [])
      .map(String)
      .join("\n"),
    defaultWeightKg: Number(settings.defaultWeightKg),
    courierStrategy: settings.courierStrategy,
    surfaceOnly: settings.surfaceOnly,
    fallbackToAny: settings.fallbackToAny,
    showRange: settings.showRange,
    widgetTitle: settings.widgetTitle,
    cacheTtlMinutes: settings.cacheTtlMinutes,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "save");

  try {
    if (intent === "test") {
      const pincode = String(form.get("testPincode") || "").trim();
      if (!PINCODE_PATTERN.test(pincode)) {
        throw new Error("Enter a valid 6-digit pincode to test.");
      }
      // Bypass the settings cache so a just-saved form is honoured, and run
      // the full lookup even while the storefront widget is disabled.
      invalidateDeliverySettings(session.shop);
      const estimate = await getDeliveryEstimate({
        db,
        shopDomain: session.shop,
        pincode,
        force: true,
      });
      return {
        ok: true,
        test: describeEstimate(pincode, estimate, estimate.enabled),
      };
    }

    const holidays = String(form.get("holidays") || "")
      .split(/[\n,]+/)
      .map((line) => line.trim())
      .filter(Boolean);
    const workingDays = WEEKDAYS.map((d) => d.value).filter((value) =>
      formBoolean(form.get(`workingDay${value}`)),
    );

    const data = deliverySettingsSchema.parse({
      enabled: formBoolean(form.get("enabled")),
      pickupPincode: String(form.get("pickupPincode") || "").trim(),
      cutoffHour: formNumber(form.get("cutoffHour")),
      workingDays,
      holidays,
      defaultWeightKg: Number(form.get("defaultWeightKg")),
      courierStrategy: String(form.get("courierStrategy") || "recommended"),
      surfaceOnly: formBoolean(form.get("surfaceOnly")),
      fallbackToAny: formBoolean(form.get("fallbackToAny")),
      showRange: formBoolean(form.get("showRange")),
      widgetTitle: String(form.get("widgetTitle") || "").trim(),
      cacheTtlMinutes: formNumber(form.get("cacheTtlMinutes")),
    });

    await updateDeliverySettings({ db, shopDomain: session.shop, data });
    return { ok: true, message: "Delivery settings saved." };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Could not save delivery settings.",
    };
  }
};

function describeEstimate(
  pincode: string,
  estimate: Awaited<ReturnType<typeof getDeliveryEstimate>>,
  featureEnabled: boolean,
): string {
  const prefix = featureEnabled ? "" : "(feature currently disabled) ";
  if (!estimate.serviceable) {
    return `${prefix}${pincode}: not serviceable by any configured courier.`;
  }
  return (
    `${prefix}${pincode}: delivery by ${estimate.deliveryText} — dispatch ` +
    `${estimate.dispatchDate}, ${estimate.transitDays} transit days via ` +
    `${estimate.courierName} (${estimate.mode}${estimate.cached ? ", cached" : ", live"})`
  );
}

export default function DeliveryPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Delivery estimates">
      <s-stack direction="block" gap="large-100">
        {actionData && "message" in actionData && actionData.message ? (
          <s-banner tone={actionData.ok ? "success" : "critical"}>
            {actionData.message}
          </s-banner>
        ) : null}
        {actionData && "test" in actionData && actionData.test ? (
          <s-banner tone="info">{actionData.test}</s-banner>
        ) : null}

        <s-section heading="How it works">
          <s-paragraph>
            The storefront widget asks the customer for a pincode, checks
            Shiprocket surface serviceability from your warehouse, and shows
            “Delivery by” = dispatch day + courier transit days. Orders before
            the cutoff on a working day dispatch the same day; later orders
            dispatch the next working day. Estimates are cached per pincode.
          </s-paragraph>
        </s-section>

        <s-section heading="Settings">
          <Form method="post">
            <input type="hidden" name="intent" value="save" />
            <s-stack direction="block" gap="base">
              <s-checkbox
                name="enabled"
                value="true"
                label="Show delivery estimates on the storefront"
                defaultChecked={data.enabled}
                details="Master switch — turn on after testing below."
              />

              <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
                <s-text-field
                  name="pickupPincode"
                  label="Warehouse pickup pincode"
                  defaultValue={data.pickupPincode}
                />
                <s-number-field
                  name="cutoffHour"
                  label="Order cutoff hour (IST, 24h)"
                  min={0}
                  max={23}
                  defaultValue={String(data.cutoffHour)}
                  details="Orders before this hour dispatch same day."
                />
                <s-number-field
                  name="defaultWeightKg"
                  label="Default weight (kg)"
                  min={0.1}
                  step={0.1}
                  defaultValue={String(data.defaultWeightKg)}
                  details="Used when a product has no weight set."
                />
              </s-grid>

              <s-stack direction="block" gap="small-100">
                <s-text type="strong">Working days (dispatch days)</s-text>
                <s-stack direction="inline" gap="base">
                  {WEEKDAYS.map((day) => (
                    <s-checkbox
                      key={day.value}
                      name={`workingDay${day.value}`}
                      value="true"
                      label={day.label}
                      defaultChecked={data.workingDays.includes(day.value)}
                    />
                  ))}
                </s-stack>
              </s-stack>

              <s-text-area
                name="holidays"
                label="Holiday calendar"
                defaultValue={data.holidays}
                rows={4}
                details="One date per line, YYYY-MM-DD. No dispatch on these dates."
              />

              <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
                <s-select
                  name="courierStrategy"
                  label="Courier for the estimate"
                  value={data.courierStrategy}
                >
                  <s-option value="recommended">
                    Shiprocket recommended
                  </s-option>
                  <s-option value="fastest">Fastest surface courier</s-option>
                </s-select>
                <s-number-field
                  name="cacheTtlMinutes"
                  label="Cache estimates for (minutes)"
                  min={5}
                  max={10080}
                  defaultValue={String(data.cacheTtlMinutes)}
                />
                <s-text-field
                  name="widgetTitle"
                  label="Widget title"
                  defaultValue={data.widgetTitle}
                />
              </s-grid>

              <s-stack direction="inline" gap="large-100">
                <s-checkbox
                  name="surfaceOnly"
                  value="true"
                  label="Surface couriers only"
                  defaultChecked={data.surfaceOnly}
                />
                <s-checkbox
                  name="fallbackToAny"
                  value="true"
                  label="Fall back to any courier when no surface option"
                  defaultChecked={data.fallbackToAny}
                  details="e.g. North-East pincodes that are air-only"
                />
                <s-checkbox
                  name="showRange"
                  value="true"
                  label="Show a 2-day range instead of a single date"
                  defaultChecked={data.showRange}
                />
              </s-stack>

              <s-stack direction="inline" gap="base">
                <s-button variant="primary" type="submit">
                  Save settings
                </s-button>
              </s-stack>
            </s-stack>
          </Form>
        </s-section>

        <s-section heading="Test a pincode">
          <s-paragraph>
            Runs the exact storefront lookup (Shiprocket call, courier choice,
            dispatch and delivery date) and shows the result here — works even
            while the widget is disabled.
          </s-paragraph>
          <Form method="post">
            <input type="hidden" name="intent" value="test" />
            <s-stack direction="inline" gap="base" alignItems="end">
              <s-text-field name="testPincode" label="Destination pincode" />
              <s-button type="submit">Get estimate</s-button>
            </s-stack>
          </Form>
        </s-section>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
