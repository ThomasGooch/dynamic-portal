import type { ReactNode } from "react";
import type { ComponentName } from "@portal/catalog";
import type { UiNode } from "@portal/protocol";
import type { Renderer } from "./kinds";
import * as action from "./components/action";
import { Chart } from "./components/chart";
import * as display from "./components/display";
import * as input from "./components/input";
import * as layout from "./components/layout";
import { Table } from "./components/table";

/**
 * Catalog name → the React component that draws it.
 *
 * The map's type is the *whole* catalog, so adding a component to
 * `@portal/catalog` without adding it here is a compile error rather than a
 * placeholder a user finds. That is the property worth having: the catalog is
 * the contract, and this file is the proof the hub honours all of it.
 */
export const RENDERERS: { [N in ComponentName]: Renderer<N> } = {
  // Layout
  Page: layout.Page,
  Section: layout.Section,
  Stack: layout.Stack,
  Grid: layout.Grid,
  Card: layout.Card,
  Tabs: layout.Tabs,
  Divider: layout.Divider,
  Modal: layout.Modal,

  // Display
  Heading: display.Heading,
  Text: display.Text,
  Badge: display.Badge,
  StatTile: display.StatTile,
  KeyValueList: display.KeyValueList,
  Table,
  Chart,
  Alert: display.Alert,
  EmptyState: display.EmptyState,
  Timeline: display.Timeline,

  // Input
  Form: input.Form,
  TextField: input.TextField,
  TextArea: input.TextArea,
  NumberField: input.NumberField,
  Select: input.Select,
  MultiSelect: input.MultiSelect,
  DateField: input.DateField,
  DateRange: input.DateRange,
  Checkbox: input.Checkbox,
  Switch: input.Switch,
  RadioGroup: input.RadioGroup,
  FileUpload: input.FileUpload,
  Hidden: input.Hidden,

  // Action
  Button: action.Button,
  Link: action.Link,
  MenuButton: action.MenuButton,
};

type LooseRenderer = (args: {
  props: unknown;
  node: UiNode;
  children: ReactNode[];
}) => ReactNode;

/**
 * The single place the renderer discards type information, and it does so
 * *after* the node's props have been parsed against that component's own
 * schema. Every component above is checked against its schema at construction;
 * this only erases the link between the name and the shape, which TypeScript
 * cannot follow through a runtime lookup.
 */
export function rendererFor(name: ComponentName): LooseRenderer {
  return RENDERERS[name] as unknown as LooseRenderer;
}
