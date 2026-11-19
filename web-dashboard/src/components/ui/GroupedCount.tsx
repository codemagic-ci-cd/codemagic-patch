import { Fragment } from "react";

import { formatCount } from "../../model/format";

/** Keep digit groups together when a narrow table needs to wrap a count. */
export function GroupedCount({ value }: { value: number }) {
  return formatCount(value).split(",").map((group, index) => (
    <Fragment key={index}>
      {index > 0 && <>,<wbr /></>}
      {group}
    </Fragment>
  ));
}
