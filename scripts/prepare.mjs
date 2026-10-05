// npm sets NODE_ENV=production when Pi's git installer omits dev dependencies.
if (process.env.NODE_ENV !== "production") {
	const { default: husky } = await import("husky");
	process.stdout.write(husky());
}
