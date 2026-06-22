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

  return (
    <s-page heading="Branding and widget">
      <s-section heading="Storefront surfaces">
        {actionData?.message ? (
          <s-paragraph>{actionData.message}</s-paragraph>
        ) : null}
        <Form method="post">
          <div style={{ display: "grid", gap: 14, maxWidth: 760 }}>
            <label>
              <input
                type="checkbox"
                name="homepageEnabled"
                defaultChecked={data.homepageEnabled}
              />{" "}
              Homepage widget enabled
            </label>
            <label>
              <input
                type="checkbox"
                name="productEnabled"
                defaultChecked={data.productEnabled}
              />{" "}
              Product page widget enabled
            </label>
            <label>
              <input
                type="checkbox"
                name="cartEnabled"
                defaultChecked={data.cartEnabled}
              />{" "}
              Cart widget enabled
            </label>
            <label>
              <input
                type="checkbox"
                name="accountEnabled"
                defaultChecked={data.accountEnabled}
              />{" "}
              Account/header widget enabled
            </label>
            <label>
              Logged-out message
              <textarea
                name="loggedOutMessage"
                defaultValue={data.loggedOutMessage}
                maxLength={240}
                rows={3}
              />
            </label>
            <label>
              Zero-points message
              <textarea
                name="zeroPointsMessage"
                defaultValue={data.zeroPointsMessage}
                maxLength={240}
                rows={3}
              />
            </label>
            <label>
              Primary color
              <input name="primaryColor" defaultValue={data.primaryColor} />
            </label>
            <label>
              Accent color
              <input name="accentColor" defaultValue={data.accentColor} />
            </label>
            <label>
              Background color
              <input
                name="backgroundColor"
                defaultValue={data.backgroundColor}
              />
            </label>
            <s-button type="submit">Save widget settings</s-button>
          </div>
        </Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
