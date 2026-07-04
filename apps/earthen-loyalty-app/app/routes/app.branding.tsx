import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import {
  formBoolean,
  getLoyaltyRuntimeSettings,
  updateWidgetSettings,
} from "../loyalty/settings";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getLoyaltyRuntimeSettings({
    db,
    shopDomain: session.shop,
  });
  return settings.widget;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  try {
    await updateWidgetSettings({
      db,
      shopDomain: session.shop,
      adminUser: session.id,
      data: {
        homepageEnabled: formBoolean(form.get("homepageEnabled")),
        productEnabled: formBoolean(form.get("productEnabled")),
        cartEnabled: formBoolean(form.get("cartEnabled")),
        accountEnabled: formBoolean(form.get("accountEnabled")),
        loggedOutMessage: String(form.get("loggedOutMessage")),
        zeroPointsMessage: String(form.get("zeroPointsMessage")),
        primaryColor: String(form.get("primaryColor")),
        accentColor: String(form.get("accentColor")),
        backgroundColor: String(form.get("backgroundColor")),
      },
    });
    return { ok: true, message: "Widget settings saved." };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Could not save widget settings.",
    };
  }
};

export default function BrandingPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const swatch = (color: string) => (
    <s-box
      inlineSize="24px"
      blockSize="24px"
      borderRadius="base"
      border="base"
      background="transparent"
    >
      <div
        style={{
          background: color,
          borderRadius: 6,
          height: "100%",
          width: "100%",
        }}
      />
    </s-box>
  );

  return (
    <s-page heading="Branding & widget">
      <s-stack direction="block" gap="large-100">
        {actionData?.message ? (
          <s-banner tone={actionData.ok ? "success" : "critical"}>
            {actionData.message}
          </s-banner>
        ) : null}

        <Form method="post">
          <s-stack direction="block" gap="large-100">
            <s-section heading="Storefront surfaces">
              <s-stack direction="block" gap="base">
                <s-checkbox
                  name="homepageEnabled"
                  value="true"
                  defaultChecked={data.homepageEnabled}
                  label="Homepage widget"
                />
                <s-checkbox
                  name="productEnabled"
                  value="true"
                  defaultChecked={data.productEnabled}
                  label="Product page widget"
                />
                <s-checkbox
                  name="cartEnabled"
                  value="true"
                  defaultChecked={data.cartEnabled}
                  label="Cart widget (side cart & cart page)"
                />
                <s-checkbox
                  name="accountEnabled"
                  value="true"
                  defaultChecked={data.accountEnabled}
                  label="Account / header popover widget"
                />
              </s-stack>
            </s-section>

            <s-section heading="Messages">
              <s-stack direction="block" gap="base">
                <s-text-area
                  name="loggedOutMessage"
                  label="Logged-out message"
                  defaultValue={data.loggedOutMessage}
                  rows={2}
                  details="Shown to visitors who are not signed in."
                />
                <s-text-area
                  name="zeroPointsMessage"
                  label="Zero-points message"
                  defaultValue={data.zeroPointsMessage}
                  rows={2}
                  details="Shown to signed-in customers with no points yet."
                />
              </s-stack>
            </s-section>

            <s-section heading="Brand colors">
              <s-stack direction="block" gap="base">
                <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
                  <s-text-field
                    name="primaryColor"
                    label="Primary color"
                    defaultValue={data.primaryColor}
                    details="Buttons and highlights, e.g. #112557"
                  />
                  {swatch(data.primaryColor)}
                </s-grid>
                <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
                  <s-text-field
                    name="accentColor"
                    label="Accent color"
                    defaultValue={data.accentColor}
                    details="Secondary emphasis, e.g. #cca268"
                  />
                  {swatch(data.accentColor)}
                </s-grid>
                <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="end">
                  <s-text-field
                    name="backgroundColor"
                    label="Background color"
                    defaultValue={data.backgroundColor}
                    details="Widget card background, e.g. #fffaf0"
                  />
                  {swatch(data.backgroundColor)}
                </s-grid>
              </s-stack>
            </s-section>

            <s-stack direction="inline" gap="base">
              <s-button variant="primary" type="submit">
                Save widget settings
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-stack>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
