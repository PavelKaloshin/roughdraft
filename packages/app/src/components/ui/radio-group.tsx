import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import type { VariantProps } from "class-variance-authority";

import { toggleVariants } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("grid w-full gap-2", className)}
      {...props}
    />
  );
}

/**
 * A radio rendered as one segment of a segmented control: toggle styling,
 * radio semantics (`role="radio"`, `aria-checked`, roving focus from the
 * group). Put several in a `RadioGroup` laid out as a row with no gap.
 */
function RadioGroupSegment({
  className,
  variant = "outline",
  size = "sm",
  ...props
}: RadioPrimitive.Root.Props & VariantProps<typeof toggleVariants>) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-segment"
      data-variant={variant}
      className={cn(
        toggleVariants({ variant, size }),
        // Each radio is followed by Base UI's hidden input, so position
        // styles use *-of-type (the segments are the group's only spans).
        "shrink-0 cursor-pointer rounded-none select-none first-of-type:rounded-l-md last-of-type:rounded-r-md not-first-of-type:border-l-0 focus:z-10 focus-visible:z-10 data-checked:bg-muted",
        className,
      )}
      {...props}
    />
  );
}

export { RadioGroup, RadioGroupSegment };
