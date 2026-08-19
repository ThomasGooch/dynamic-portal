"use client";

import type { FormEvent, ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRender } from "../context";
import { collectFormValues, initialFormValues } from "../formValues";
import type { Renderer } from "../kinds";
import { isVisible, type VisibleWhen } from "../visibility";

/**
 * Inputs, and the `Form` that submits them.
 *
 * Every control is **uncontrolled** — `defaultValue`, not `value`. That is not
 * laziness: the satellite's tree is the source of truth for what a field starts
 * as, and a `patch` that replaces a form gives it new defaults by remounting.
 * Mirroring every keystroke into React state would add a second source of truth
 * for something no other part of the system reads.
 *
 * Field errors come from the last `validation` outcome and are keyed by the
 * field's own `name`, which is why `name` is required by the catalog: it is the
 * join between what the satellite validated and what the user is looking at.
 */

const fieldId = (name: string): string => `field-${name}`;
const errorId = (name: string): string => `field-${name}-error`;
const helpId = (name: string): string => `field-${name}-help`;

interface FieldShell {
  readonly name: string;
  readonly label: string;
  readonly required?: boolean | undefined;
  readonly help?: string | undefined;
  readonly visibleWhen?: VisibleWhen | undefined;
}

function Field({
  meta,
  children,
  as = "label",
}: {
  meta: FieldShell;
  children: ReactNode;
  /** A radio group labels itself with a legend; anything else with a label. */
  as?: "label" | "group";
}) {
  const { fieldErrors } = useRender();
  const error = fieldErrors[meta.name];
  const visible = useVisible(meta);

  // One place, so every input that shells through `Field` gets this rather than
  // each remembering to. Returning null removes it from the DOM, which is also
  // what keeps it out of the submission — `collectFormValues` reads the form's
  // own elements. The two controls that do not shell through `Field` —
  // `Toggle` and the fieldset around `RadioGroup` — call `useVisible`
  // themselves.
  if (!visible) return null;

  const caption = (
    <>
      {meta.label}
      {meta.required === true && (
        <abbr className="r-required" title="Required">
          *
        </abbr>
      )}
    </>
  );

  return (
    <div className="r-field" data-invalid={error === undefined ? undefined : ""}>
      {as === "label" ? (
        <label className="r-label" htmlFor={fieldId(meta.name)}>
          {caption}
        </label>
      ) : (
        <span className="r-label">{caption}</span>
      )}
      {children}
      {meta.help !== undefined && (
        <small className="r-help" id={helpId(meta.name)}>
          {meta.help}
        </small>
      )}
      {error !== undefined && (
        <small className="r-fieldError" id={errorId(meta.name)}>
          {error}
        </small>
      )}
    </div>
  );
}

/** Wires a control to its help text and its error message for assistive tech. */
function aria(name: string, hasHelp: boolean, hasError: boolean) {
  const described = [hasHelp ? helpId(name) : undefined, hasError ? errorId(name) : undefined]
    .filter((value): value is string => value !== undefined)
    .join(" ");
  return {
    id: fieldId(name),
    ...(described === "" ? {} : { "aria-describedby": described }),
    ...(hasError ? { "aria-invalid": true as const } : {}),
  };
}

function useAria(meta: FieldShell) {
  const { fieldErrors } = useRender();
  return aria(meta.name, meta.help !== undefined, fieldErrors[meta.name] !== undefined);
}

interface FormState {
  /** What every field on this form currently holds, hidden ones excepted. */
  readonly values: Record<string, unknown>;
  /** Every field the form declared, hidden or not. See `isVisible`. */
  readonly declared: ReadonlySet<string>;
}

/**
 * The state a `visibleWhen` is evaluated against.
 *
 * Empty outside a form, which is what makes a `visibleWhen` on a stray field
 * render it rather than hide it: a condition that can never be evaluated
 * should not silently remove a control.
 */
const FormValues = createContext<FormState>({ values: {}, declared: new Set() });

/**
 * Whether two readings of a form say the same thing.
 *
 * Enough for what `collectFormValues` produces — strings, numbers, booleans,
 * `null`, an array of strings, and one level of nesting for a `DateRange` — and
 * deliberately not a general deep-equal, which would be a larger promise than
 * this needs and slower on every keystroke.
 */
function unchanged(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  const keys = Object.keys(before);
  return keys.length === Object.keys(after).length && keys.every((key) => same(before[key], after[key]));
}

function same(before: unknown, after: unknown): boolean {
  if (Array.isArray(before) || Array.isArray(after)) {
    return (
      Array.isArray(before) &&
      Array.isArray(after) &&
      before.length === after.length &&
      before.every((entry, index) => entry === after[index])
    );
  }
  if (typeof before === "object" && before !== null && typeof after === "object" && after !== null) {
    return unchanged(before as Record<string, unknown>, after as Record<string, unknown>);
  }
  return before === after;
}

/** `isVisible` against the form this field is rendered in. */
function useVisible(meta: FieldShell): boolean {
  const { values, declared } = useContext(FormValues);
  return isVisible(meta.visibleWhen, values, declared);
}

export const Form: Renderer<"Form"> = ({ props, node, children }) => {
  const { dispatch, busy } = useRender();
  const form = useRef<HTMLFormElement>(null);

  // Seeded from the satellite's own tree rather than from an empty object: the
  // hub server-renders this, and there is no DOM to read until hydration. A
  // conditional field would otherwise be drawn on the server and removed on
  // hydration — a flash of a field whose condition was never met.
  const initial = useMemo(() => initialFormValues(node), [node]);
  const declared = useMemo(() => new Set(Object.keys(initial)), [initial]);
  const [values, setValues] = useState<Record<string, unknown>>(initial);

  // Read from the DOM after that rather than held per field: the fields stay
  // uncontrolled, which is what keeps `defaultValue` working and the renderer
  // free of a state tree mirroring every input. `change` bubbles, so one
  // handler sees them all — and React's `change` *is* the input event, so
  // typing into a text field updates a condition without waiting for blur.
  const sync = () => {
    if (form.current === null) return;
    const next = collectFormValues(form.current, { includeDisabled: true });
    // Same reading, same object: a new one on every keystroke would re-render
    // every field on the form for nothing.
    setValues((previous) => (unchanged(previous, next) ? previous : next));
  };

  // After every render, not only the first. A field that has just been removed
  // has to stop feeding conditions in the same breath, or the value it held
  // when it vanished keeps a field that depends on it on the screen — and in
  // the payload. Hiding only ever causes more hiding, so this settles.
  useEffect(sync);

  const state = useMemo(() => ({ values, declared }), [values, declared]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    // The hub posts through its own proxy; a real form submission would take
    // the browser to a satellite the browser is not supposed to know exists.
    event.preventDefault();
    dispatch({
      actionId: props.actionId,
      // Collected from the DOM, so a hidden field is absent because it is not
      // rendered — not because anything filtered it out.
      payload: collectFormValues(event.currentTarget),
      ...(props.confirm === undefined ? {} : { confirm: props.confirm }),
    });
  };

  return (
    <form className="r-form" onSubmit={onSubmit} onChange={sync} ref={form} noValidate>
      <FormValues.Provider value={state}>{children}</FormValues.Provider>
      <div className="r-formActions">
        <button type="submit" className="r-button" data-variant="primary" disabled={busy}>
          {busy ? "Working…" : (props.submitLabel ?? "Submit")}
        </button>
      </div>
    </form>
  );
};

export const TextField: Renderer<"TextField"> = ({ props }) => (
  <Field meta={props}>
    <input
      {...useAria(props)}
      className="r-input"
      type="text"
      name={props.name}
      defaultValue={props.value ?? ""}
      placeholder={props.placeholder ?? ""}
      disabled={props.disabled === true}
      required={props.required === true}
    />
  </Field>
);

export const TextArea: Renderer<"TextArea"> = ({ props }) => (
  <Field meta={props}>
    <textarea
      {...useAria(props)}
      className="r-input"
      name={props.name}
      rows={props.rows ?? 4}
      defaultValue={props.value ?? ""}
      disabled={props.disabled === true}
      required={props.required === true}
    />
  </Field>
);

export const NumberField: Renderer<"NumberField"> = ({ props }) => (
  <Field meta={props}>
    <input
      {...useAria(props)}
      className="r-input"
      type="number"
      name={props.name}
      defaultValue={props.value ?? ""}
      // Bounds are *data* on a NumberField, not schema constraints — the
      // catalog carries no ranges so that one definition serves the agent's
      // strict schema too. Here they become what they always meant.
      {...(props.min === undefined ? {} : { min: props.min })}
      {...(props.max === undefined ? {} : { max: props.max })}
      {...(props.step === undefined ? {} : { step: props.step })}
      disabled={props.disabled === true}
      required={props.required === true}
    />
  </Field>
);

export const Select: Renderer<"Select"> = ({ props }) => {
  // A `value` naming no option is not a selection. The browser would silently
  // fall back to the first option, so the satellite's own default would be
  // submitted as whatever happened to be listed first — the placeholder is the
  // honest rendering of "nothing is chosen".
  const selected =
    props.value !== undefined && props.options.some((option) => option.value === props.value)
      ? props.value
      : undefined;

  return (
    <Field meta={props}>
      <select
        {...useAria(props)}
        className="r-input"
        name={props.name}
        defaultValue={selected ?? ""}
        disabled={props.disabled === true}
        required={props.required === true}
      >
        {selected === undefined && <option value="">Choose…</option>}
        {props.options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled === true}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
};

export const MultiSelect: Renderer<"MultiSelect"> = ({ props }) => (
  <Field meta={props}>
    <select
      {...useAria(props)}
      className="r-input"
      name={props.name}
      multiple
      defaultValue={props.value ?? []}
      disabled={props.disabled === true}
      required={props.required === true}
      size={Math.min(props.options.length || 1, 6)}
    >
      {props.options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled === true}>
          {option.label}
        </option>
      ))}
    </select>
  </Field>
);

export const DateField: Renderer<"DateField"> = ({ props }) => (
  <Field meta={props}>
    <input
      {...useAria(props)}
      className="r-input"
      type="date"
      name={props.name}
      defaultValue={props.value ?? ""}
      disabled={props.disabled === true}
      required={props.required === true}
    />
  </Field>
);

export const DateRange: Renderer<"DateRange"> = ({ props }) => (
  <Field meta={props} as="group">
    {/* Two controls, one field. The dotted names nest on collection, so the
        satellite receives `{from, to}` — the same shape it declared. */}
    <div className="r-dateRange">
      <input
        className="r-input"
        id={fieldId(props.name)}
        type="date"
        name={`${props.name}.from`}
        aria-label={`${props.label} from`}
        defaultValue={props.from ?? ""}
        disabled={props.disabled === true}
      />
      <span aria-hidden="true">→</span>
      <input
        className="r-input"
        type="date"
        name={`${props.name}.to`}
        aria-label={`${props.label} to`}
        defaultValue={props.to ?? ""}
        disabled={props.disabled === true}
      />
    </div>
  </Field>
);

/** Checkbox and Switch differ in presentation, not in what they submit. */
function Toggle({
  props,
  variant,
}: {
  props: { name: string; label: string; checked?: boolean | undefined; disabled?: boolean | undefined; help?: string | undefined; required?: boolean | undefined; visibleWhen?: VisibleWhen | undefined };
  variant: "checkbox" | "switch";
}) {
  const { fieldErrors } = useRender();
  const error = fieldErrors[props.name];
  // A toggle draws its own shell rather than going through `Field`, so it has
  // to ask the same question itself — the catalog offers `visibleWhen` on every
  // field, and a checkbox that ignored it would be shown whatever it declared.
  const visible = useVisible(props);

  if (!visible) return null;

  return (
    <div className="r-field" data-invalid={error === undefined ? undefined : ""}>
      <label className="r-toggle" data-variant={variant}>
        <input
          {...aria(props.name, props.help !== undefined, error !== undefined)}
          type="checkbox"
          name={props.name}
          defaultChecked={props.checked === true}
          disabled={props.disabled === true}
        />
        <span>{props.label}</span>
      </label>
      {props.help !== undefined && (
        <small className="r-help" id={helpId(props.name)}>
          {props.help}
        </small>
      )}
      {error !== undefined && (
        <small className="r-fieldError" id={errorId(props.name)}>
          {error}
        </small>
      )}
    </div>
  );
}

export const Checkbox: Renderer<"Checkbox"> = ({ props }) => (
  <Toggle props={props} variant="checkbox" />
);

export const Switch: Renderer<"Switch"> = ({ props }) => <Toggle props={props} variant="switch" />;

export const RadioGroup: Renderer<"RadioGroup"> = ({ props }) => {
  // Asked here rather than left to `Field`: the fieldset is outside it, so a
  // hidden group would otherwise leave an empty bordered box on the form.
  const visible = useVisible(props);
  if (!visible) return null;

  return (
    <fieldset className="r-fieldset" disabled={props.disabled === true}>
      <Field meta={props} as="group">
        <div className="r-radios">
          {props.options.map((option) => (
            <label key={option.value} className="r-radio">
              <input
                type="radio"
                name={props.name}
                value={option.value}
                defaultChecked={props.value === option.value}
                disabled={option.disabled === true}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </Field>
    </fieldset>
  );
};

export const FileUpload: Renderer<"FileUpload"> = ({ props }) => (
  <Field meta={props}>
    <input
      {...useAria(props)}
      className="r-input"
      type="file"
      name={props.name}
      {...(props.accept === undefined ? {} : { accept: props.accept.join(",") })}
      multiple={props.multiple === true}
      disabled={props.disabled === true}
    />
    {/* Said out loud rather than discovered on submit. The action envelope is
        JSON and carries no file, so the chosen file is deliberately left out of
        the payload — sending its name alone would read as an upload that
        worked. Uploads need a protocol addition, not a renderer workaround. */}
    <small className="r-help r-warn">
      File uploads are not yet carried by the portal protocol; this file will not be sent.
    </small>
  </Field>
);

export const Hidden: Renderer<"Hidden"> = ({ props }) => (
  <input type="hidden" name={props.name} defaultValue={props.value} />
);
