// Makes a hand-captured static DOM look React-rendered to the extension, so a
// plugin that drives a React site (bsc.reactClick, ...) can be tested against
// it: the page is marked as React, and elements carry React-style props, which
// is where the extension reads handlers from. Not a real React render — see
// react/react-app.html for that.
document.documentElement.setAttribute("data-bsc-react", "fixture");
function reactify(el, props) {
  el["__reactProps$fixture"] = props;
  return el;
}
