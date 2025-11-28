import SignupForm from "../SignupForm";

export default function SignupFormExample() {
  return (
    <SignupForm
      isVendor={false}
      onComplete={(data) => console.log("Signup complete:", data)}
    />
  );
}
