import test from "node:test";
import assert from "node:assert/strict";

import { awsKind, classifyAws, parseAwsCommand, splitCommand } from "./policy.mjs";

const POLICY = { tiers: { aws: { default: "test", dev: ["test"], ppd: ["stage"], prd: ["live"], skip: ["stage-mfa"] } } };
const decide = (cli_command, tool = "call_aws") => classifyAws("aws", tool, { cli_command }, POLICY);
const kind = (command) => awsKind(parseAwsCommand(command));

test("splitCommand handles quotes and backslashes like a shell", () => {
	assert.deepEqual(splitCommand(`aws s3 ls "s3://b/a b" 'x y' c\\ d`), ["aws", "s3", "ls", "s3://b/a b", "x y", "c d"]);
	assert.deepEqual(splitCommand(`aws logs filter-log-events --filter-pattern "\\"x\\""`), [
		"aws",
		"logs",
		"filter-log-events",
		"--filter-pattern",
		'"x"',
	]);
	assert.equal(splitCommand(`aws s3 ls "open`), null);
});

test("parseAwsCommand skips global options before the service and takes the last --profile", () => {
	assert.deepEqual(parseAwsCommand("aws --profile live --output json ec2 describe-instances --instance-ids i-1"), {
		service: "ec2",
		op: "describe-instances",
		profile: "live",
		flags: new Set(["--profile", "--output", "--instance-ids"]),
	});
	assert.equal(parseAwsCommand("aws s3 ls --profile=test --profile stage").profile, "stage");
	assert.equal(parseAwsCommand("aws sts get-caller-identity").profile, undefined);
	assert.equal(parseAwsCommand("aws s3"), null, "no operation");
	assert.equal(parseAwsCommand("kubectl get pods"), null);
});

test("awsKind sorts credential calls, reads, destructive operations and writes", () => {
	assert.equal(kind("aws secretsmanager get-secret-value --secret-id x"), "secret");
	assert.equal(kind("aws ssm get-parameter --name p --with-decryption"), "secret");
	assert.equal(kind("aws ssm get-parameter --name p"), "read");
	assert.equal(kind("aws eks get-token --cluster-name c"), "secret");
	assert.equal(kind("aws s3 presign s3://b/k"), "secret");
	assert.equal(kind("aws ec2 describe-instances"), "read");
	assert.equal(kind("aws s3 ls s3://b"), "read");
	assert.equal(kind("aws ec2 wait instance-running --instance-ids i-1"), "read");
	assert.equal(kind("aws ec2 terminate-instances --instance-ids i-1"), "destructive");
	assert.equal(kind("aws s3 rm s3://b/k"), "destructive");
	assert.equal(kind("aws s3 sync s3://a s3://b --delete"), "destructive");
	assert.equal(kind("aws s3 sync s3://a s3://b"), "write");
	assert.equal(kind("aws ecs update-service --cluster c --service s --force-new-deployment"), "write");
});

test("tiers come from --profile, else the default profile", () => {
	assert.equal(decide("aws ecs update-service --cluster c --service s").decision, "allow", "default test is dev");
	assert.deepEqual(decide("aws ecs update-service --cluster c --service s --profile stage").reasons, [
		"writes on ppd profile stage (ecs update-service)",
	]);
	assert.equal(decide("aws ec2 describe-instances --profile live").decision, "allow");
	assert.equal(decide("aws ec2 describe-instances --profile unknown").decision, "allow", "reads pass on prd");
	assert.equal(decide("aws ec2 delete-volume --volume-id v --profile unknown").decision, "confirm");
	assert.equal(decide("aws secretsmanager get-secret-value --secret-id x").decision, "confirm", "secret on dev");
});

test("a skipped profile anywhere in a batch refuses the whole call", () => {
	const res = decide(["aws ec2 describe-instances", "aws s3 ls --profile stage-mfa"]);
	assert.equal(res.decision, "deny");
	assert.deepEqual(res.reasons, ["profile stage-mfa (s3 ls) is skipped in tiers.json"]);
});

test("unparsable or missing commands are prd writes; unknown tools ask; suggestions pass", () => {
	assert.equal(decide("aws s3 cp 'open").decision, "confirm");
	assert.equal(decide(undefined).decision, "confirm");
	assert.equal(decide([42]).decision, "confirm");
	assert.equal(classifyAws("aws", "suggest_aws_commands", { query: "list buckets" }, POLICY).decision, "allow");
	assert.deepEqual(classifyAws("aws", "get_execution_plan", {}, POLICY).reasons, ["unknown tool get_execution_plan"]);
});
