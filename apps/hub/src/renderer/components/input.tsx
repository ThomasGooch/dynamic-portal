"use client";

import type { FormEvent, ReactNode } from "react";
import { useRender } from "../context";
import { collectFormValues } from "../formValues";
import type { Renderer } from "../kinds";

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

export const Form: Renderer<"Form"> = ({ props, children }) => {
  const { dispatch, busy } = useRender();

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    // The hub posts through its own proxy; a real form submission would take
    // the browser to a satellite the browser is not supposed to know exists.
    event.preventDefault();
    dispatch({
      actionId: props.actionId,
      payload: collectFormValues(event.currentTarget),
      ...(props.confirm === undefined ? {} : { confirm: props.confirm }),
    });
  };

  return (
    <form className="r-form" onSubmit={onSubmit} noValidate>
      {children}
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

export const Select: Renderer<"Select"> = ({ props }) => (
  <Field meta={props}>
    <select
      {...useAria(props)}
      className="r-input"
      name={props.name}
      defaultValue={props.value ?? ""}
      disabled={props.disabled === true}
      required={props.required === true}
    >
      {props.value === undefined && <option value="">Choose…</option>}
      {props.options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled === true}>
          {option.label}
        </option>
      ))}
    </select>
  </Field>
);

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
  props: { name: string; label: string; checked?: boolean | undefined; disabled?: boolean | undefined; help?: string | undefined; required?: boolean | undefined };
  variant: "checkbox" | "switch";
}) {
  const { fieldErrors } = useRender();
  const error = fieldErrors[props.name];

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

export const RadioGroup: Renderer<"RadioGroup"> = ({ props }) => (
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
